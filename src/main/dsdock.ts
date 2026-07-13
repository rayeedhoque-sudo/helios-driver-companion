// DS dock (M3): embeds the real FRC Driver Station window via Win32 SetParent
// (through koffi). Exported signatures are FROZEN; main.ts wiring depends on them.
//
// Persistence: none, on purpose (in-memory saved-state only). On a clean exit
// restoreDs() un-parents the DS first. On a hard kill while docked, Windows
// destroys the DS *window* together with its parent HWND, so a fresh app run
// can never observe a previously-docked DS — only the orphaned
// DriverStation.exe process, which {found:false, exeRunning:true} surfaces as
// the "Restart DS" hint.
import { screen, type BrowserWindow } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import koffi from 'koffi';

export type DsStation = 'R1' | 'R2' | 'R3' | 'B1' | 'B2' | 'B3';

export type DsStatus = {
  found: boolean;
  docked: boolean;
  heightDip: number | null;
  exeRunning: boolean;
  dsStation: DsStation | null; // null if the ini is missing/unreadable/out-of-range
};

const DS_EXE = 'C:\\Program Files (x86)\\FRC Driver Station\\DriverStation.exe';
const DS_TITLE_FRAGMENT = 'FRC Driver Station'; // title contains, never exact-match

// --- DS station (local DS-saved selection) --------------------------------------
// The DS persists its team-station dropdown to this ini. VERIFIED 2026-07-11: it is
// written on DS exit, NOT live on dropdown change (observed dropdown=B1 while the ini
// still said R1 mid-session; the 1741 dashboard feed and 1742 JSON don't carry the
// station either, so no live outside source exists). The renderer therefore only
// adopts this value at moments it's fresh: DS launch (DS just read it) and value
// change (DS just wrote it). Untrusted text file: parse only the one key we need,
// tolerate whitespace/quotes/CRLF, never eval.
const DS_INI_PATH = 'C:\\Users\\Public\\Documents\\FRC\\FRC DS Data Storage.ini';
// FRC DS alliance-station encoding: 0=R1 1=R2 2=R3 3=B1 4=B2 5=B3.
// TODO: spot-check live at the next DS session (flip the DS station dropdown, watch this value).
const STATION_BY_INDEX: DsStation[] = ['R1', 'R2', 'R3', 'B1', 'B2', 'B3'];

let dsStation: DsStation | null = null;
let dsIniMtimeMs: number | null = null;

function parseTeamStation(iniText: string): number | null {
  const m = /^\s*TeamStation\s*=\s*"?(\d+)"?\s*$/m.exec(iniText);
  return m ? Number(m[1]) : null;
}

// Re-stat + re-read only when the file's mtime moved since the last check — a
// stat every 2 s (piggybacked on the existing scan tick) is nothing, but there's
// no reason to re-parse the ini when it hasn't changed.
function refreshDsStation(): void {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(DS_INI_PATH).mtimeMs;
  } catch {
    dsStation = null;
    dsIniMtimeMs = null;
    return;
  }
  if (dsIniMtimeMs === mtimeMs) return;
  dsIniMtimeMs = mtimeMs;
  try {
    const idx = parseTeamStation(readFileSync(DS_INI_PATH, 'utf8'));
    dsStation = idx !== null && idx >= 0 && idx < STATION_BY_INDEX.length ? STATION_BY_INDEX[idx] : null;
  } catch {
    dsStation = null;
  }
}

// --- Win32 bindings ----------------------------------------------------------
const user32 = koffi.load('user32.dll');

koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' });
koffi.proto('bool EnumWindowsProc(intptr_t hwnd, intptr_t lparam)');

const EnumWindows = user32.func('bool EnumWindows(EnumWindowsProc* cb, intptr_t lparam)');
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t hwnd, _Out_ uint16_t* buf, int max)');
const IsWindow = user32.func('bool IsWindow(intptr_t hwnd)');
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool IsIconic(intptr_t hwnd)');
const ShowWindow = user32.func('bool ShowWindow(intptr_t hwnd, int cmd)');
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t hwnd, _Out_ RECT* rect)');
const GetClientRect = user32.func('bool GetClientRect(intptr_t hwnd, _Out_ RECT* rect)');
const ClientToScreen = user32.func('bool ClientToScreen(intptr_t hwnd, _Inout_ POINT* pt)');
const GetWindowLongPtrW = user32.func('intptr_t GetWindowLongPtrW(intptr_t hwnd, int index)');
const SetWindowLongPtrW = user32.func('intptr_t SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)');
const SetParent = user32.func('intptr_t SetParent(intptr_t child, intptr_t parent)');
const GetParent = user32.func('intptr_t GetParent(intptr_t hwnd)');
const GetAncestor = user32.func('intptr_t GetAncestor(intptr_t hwnd, uint32_t flags)');
const SetWindowPos = user32.func(
  'bool SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)',
);
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vkey)');
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()');
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT* pt)');

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
// Clip flags — without these, every Chromium present blits the dashboard over
// the docked DS's rectangle, and each DS repaint paints it back (visible as
// "dashboard bleeds through the DS on every DS update"). CLIPCHILDREN on the
// host excludes child rects from parent-surface drawing; CLIPSIBLINGS on the
// DS keeps sibling draws out of its region.
const WS_CLIPCHILDREN = 0x02000000;
const WS_CLIPSIBLINGS = 0x04000000;
const GA_PARENT = 1;
const SW_RESTORE = 9;
const VK_LBUTTON = 0x01;
// SWP_NOSIZE | SWP_NOMOVE | SWP_FRAMECHANGED | SWP_NOACTIVATE — no NOZORDER:
// with hwndInsertAfter = HWND_TOP this raises the DS above Electron's
// compositor child ("Intermediate D3D Window"), which otherwise paints the
// renderer over the docked DS (verified by screenshot: DS invisible without it).
const SWP_APPLY_FRAME = 0x0033;
// SWP_NOACTIVATE — reposition must never steal keyboard focus from the renderer.
const SWP_NOACTIVATE = 0x0010;
// SWP_FRAMECHANGED | SWP_SHOWWINDOW (used with HWND_TOP = 0)
const SWP_RESTORE_SHOW = 0x0060;
// SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE — z-order-only re-assert (no geometry).
const SWP_ZORDER_ONLY = 0x0013;

type Rect = { left: number; top: number; right: number; bottom: number };

function winRect(hwnd: number): Rect {
  const r: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  GetWindowRect(hwnd, r);
  return r;
}
function appClientRect(hwnd: number): Rect {
  const r: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  GetClientRect(hwnd, r);
  return r;
}
function clientOriginScreen(hwnd: number): { x: number; y: number } {
  const p = { x: 0, y: 0 };
  ClientToScreen(hwnd, p);
  return p;
}
function styleOf(hwnd: number, index: number): number {
  // Low 32 bits are the style; >>>0 normalizes any 64-bit sign extension.
  return Number(GetWindowLongPtrW(hwnd, index)) >>> 0;
}
function rectsEqual(a: Rect, b: Rect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

// --- module state -------------------------------------------------------------
let statusCb: ((s: DsStatus) => void) | null = null;
let hoverCb: ((h: boolean) => void) | null = null;
let hostWindow: BrowserWindow | null = null;
let appHwnd = 0;
let zoneRect = { x: 0, y: 0, w: 0, h: 0 }; // dock strip, window-DIP coords

let dsHwnd = 0;
let found = false;
let docked = false;
let exeRunning = false;
let heightDip: number | null = null;
let saved: { style: number; exStyle: number; rect: Rect } | null = null;
let savedHostStyle: number | null = null; // host style before WS_CLIPCHILDREN was added
// The DS enforces its own height (LabVIEW self-sizes, and it can change when
// DPI hosting changes) — always position with the measured docked height.
let dockedHeightPhys = 0;

// drag-to-dock tracking (only while found && !docked)
let lastDsRect: Rect | null = null;
let btnWasDown = false;
let dragSession = false; // saw the DS move while LMB down + DS foreground
let hovering = false;

let scanTimer: NodeJS.Timeout | null = null; // 2 s, while !found
let dragTimer: NodeJS.Timeout | null = null; // 75 ms, while found && !docked
let dockTimer: NodeJS.Timeout | null = null; // 1 Hz enforcement, while docked

// --- status / hover pushes ------------------------------------------------------
let lastPushed = '';
function pushStatus(): void {
  const s: DsStatus = { found, docked, heightDip: docked ? heightDip : null, exeRunning, dsStation };
  const key = JSON.stringify(s);
  if (key === lastPushed) return;
  lastPushed = key;
  try {
    statusCb?.(s);
  } catch {
    // renderer/window may already be gone during shutdown
  }
}

function setHover(h: boolean): void {
  if (h === hovering) return;
  hovering = h;
  console.log(`[dsdock] hover ${h}`);
  try {
    hoverCb?.(h);
  } catch {
    // ignore during shutdown
  }
}

// --- timers ---------------------------------------------------------------------
function toggleTimer(
  t: NodeJS.Timeout | null,
  want: boolean,
  fn: () => void,
  ms: number,
): NodeJS.Timeout | null {
  if (want && !t) return setInterval(fn, ms);
  if (!want && t) {
    clearInterval(t);
    return null;
  }
  return t;
}

function ensureTimers(): void {
  const ready = hostWindow !== null;
  scanTimer = toggleTimer(scanTimer, ready && !found, scanTick, 2000);
  dragTimer = toggleTimer(dragTimer, ready && found && !docked, dragTick, 75);
  dockTimer = toggleTimer(dockTimer, ready && docked, dockTick, 1000);
}

// --- find DS (2 s scan while not found) -------------------------------------------
function findDsWindow(): { hwnd: number; title: string } | null {
  let hit: { hwnd: number; title: string } | null = null;
  const buf = Buffer.alloc(1024);
  EnumWindows((hwnd: number) => {
    if (hwnd === appHwnd || !IsWindowVisible(hwnd)) return true;
    const len = GetWindowTextW(hwnd, buf, 512) as number;
    if (len > 0) {
      const title = buf.toString('utf16le', 0, len * 2);
      if (title.includes(DS_TITLE_FRAGMENT)) {
        hit = { hwnd, title };
        return false; // stop enumerating
      }
    }
    return true;
  }, 0);
  return hit;
}

function scanTick(): void {
  refreshDsStation(); // cheap mtime-gated re-read; runs at startup and every scan tick
  const hit = findDsWindow();
  if (hit) {
    dsHwnd = hit.hwnd;
    found = true;
    exeRunning = true; // a live window implies a live process
    lastDsRect = null;
    btnWasDown = false;
    dragSession = false;
    console.log(`[dsdock] found DS window hwnd=${hit.hwnd} title="${hit.title}"`);
    pushStatus();
    ensureTimers();
    return;
  }
  // Window absent — is the process still alive? Powers the "Restart DS" hint
  // after a hard crash destroyed the DS window but left the exe running.
  execFile('tasklist', ['/FI', 'IMAGENAME eq DriverStation.exe', '/NH'], (err, stdout) => {
    exeRunning = !err && /DriverStation\.exe/i.test(String(stdout));
    pushStatus();
  });
}

function lostDs(): void {
  dsHwnd = 0;
  found = false;
  lastDsRect = null;
  dragSession = false;
  setHover(false);
  pushStatus();
  ensureTimers();
  scanTick(); // refresh found/exeRunning promptly
}

// --- drag-to-dock (75 ms poll while found && !docked) ------------------------------
function zoneCursorHit(): boolean {
  if (!hostWindow || hostWindow.isDestroyed() || zoneRect.w <= 0 || zoneRect.h <= 0) return false;
  // ponytail: single-display DIP→physical mapping (spec'd); mixed-DPI
  // multi-monitor would need per-display physical origins.
  const cb = hostWindow.getContentBounds(); // DIP, screen-relative
  const sf = screen.getDisplayMatching(hostWindow.getBounds()).scaleFactor;
  const p = { x: 0, y: 0 };
  GetCursorPos(p); // physical px
  const zx = (cb.x + zoneRect.x) * sf;
  const zy = (cb.y + zoneRect.y) * sf;
  return p.x >= zx && p.x < zx + zoneRect.w * sf && p.y >= zy && p.y < zy + zoneRect.h * sf;
}

function dragTick(): void {
  if (!IsWindow(dsHwnd)) {
    lostDs();
    return;
  }
  const btnDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  const rect = winRect(dsHwnd);
  const moved = lastDsRect !== null && !rectsEqual(rect, lastDsRect);
  lastDsRect = rect;

  if (btnDown) {
    // A drag session starts when the DS visibly moves while LMB is down and
    // the DS is foreground; it then tracks the cursor every tick (so a pause
    // mid-drag doesn't freeze the hover state).
    if (moved && Number(GetForegroundWindow()) === dsHwnd) dragSession = true;
    if (dragSession) setHover(zoneCursorHit());
  } else {
    const dropInZone = btnWasDown && dragSession && hovering; // LMB falling edge over the zone
    dragSession = false;
    setHover(false);
    if (dropInZone) void dock();
  }
  btnWasDown = btnDown;
}

// --- docked enforcement (1 Hz + Electron window events) -----------------------------
function repositionDocked(): void {
  if (!docked || !dsHwnd || dockedHeightPhys <= 0) return;
  const c = appClientRect(appHwnd); // physical px
  const o = clientOriginScreen(appHwnd);
  // A WS_CHILD window is positioned in PARENT-CLIENT coordinates — the bottom
  // strip is simply (0, clientHeight - dsHeight). The old code passed SCREEN
  // coords and then corrected from a readback, which physically moved the DS to
  // a wrong spot and back EVERY 1 Hz tick (visible as the whole DS jumping by
  // the window's screen offset, plus LabVIEW re-layout churn mid-move).
  const ty = c.bottom - dockedHeightPhys;
  // Already exactly in place (readback is in screen coords)? Then only
  // re-assert z-order above Electron's compositor sibling — no move/size means
  // no repaint or LabVIEW re-layout.
  const r = winRect(dsHwnd);
  const inPlace =
    r.left === o.x &&
    r.top === o.y + ty &&
    r.right - r.left === c.right &&
    r.bottom - r.top === dockedHeightPhys;
  if (inPlace) {
    SetWindowPos(dsHwnd, 0, 0, 0, 0, 0, SWP_ZORDER_ONLY); // HWND_TOP
    return;
  }
  SetWindowPos(dsHwnd, 0, 0, ty, c.right, dockedHeightPhys, SWP_NOACTIVATE);
}

// LabVIEW restores its own bounds asynchronously after parent geometry
// changes, so a single immediate reposition can lose that race (observed:
// DS at its native 1050x260 near the client top until the next 1 Hz tick).
// Re-assert a few times; SetWindowPos is a near-no-op once settled.
function repositionBurst(): void {
  repositionDocked();
  for (const ms of [150, 400, 800]) {
    setTimeout(repositionDocked, ms);
  }
}

function dockTick(): void {
  if (!IsWindow(dsHwnd)) {
    // DS died while docked (closed from its own UI or crashed).
    docked = false;
    saved = null;
    heightDip = null;
    dockedHeightPhys = 0;
    lostDs();
    return;
  }
  // Re-assert rect AND top-of-siblings z-order every second (Electron can
  // re-raise its compositor window); SetWindowPos is a near-no-op when
  // nothing changed, so no drift comparison needed.
  repositionDocked();
}

// --- public API ----------------------------------------------------------------
// Begin tracking the DS window.
export function initDsDock(
  win: BrowserWindow,
  onStatus: (s: DsStatus) => void,
  onHover: (h: boolean) => void,
): void {
  hostWindow = win;
  statusCb = onStatus;
  hoverCb = onHover;
  appHwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));

  // Keep the docked DS glued to the bottom strip through geometry changes.
  // 'move' matters: the docked DS keeps WS_POPUP, and popup children do not
  // track the parent window like WS_CHILD windows do.
  win.on('resize', repositionBurst);
  win.on('move', repositionBurst);
  win.on('maximize', repositionBurst);
  win.on('unmaximize', repositionBurst);
  win.on('enter-full-screen', repositionBurst);

  pushStatus(); // initial (idle) status so the renderer paints the strip
  scanTick(); // also does the startup refreshDsStation() read
  console.log(`[dsdock] dsStation=${dsStation} (startup, from ${DS_INI_PATH})`);
  ensureTimers();
}

// Dock-strip rectangle in window DIP coords (hover-detection zone).
export function setZoneRect(rectDip: { x: number; y: number; w: number; h: number }): void {
  zoneRect = rectDip;
}

// Re-parent the DS into our window, positioned over the bottom dock strip.
export async function dock(): Promise<void> {
  if (docked || !hostWindow || !dsHwnd || !IsWindow(dsHwnd)) return;
  if (IsIconic(dsHwnd)) ShowWindow(dsHwnd, SW_RESTORE); // minimized rect is garbage (-32000)

  const rect = winRect(dsHwnd);
  const style = styleOf(dsHwnd, GWL_STYLE);
  const exStyle = styleOf(dsHwnd, GWL_EXSTYLE);
  saved = { style, exStyle, rect };

  // WS_CHILD in, WS_POPUP out. Caption bits KEPT (LabVIEW windows can
  // misdraw frameless). Two hard-won prerequisites, verified 2026-07-11:
  // - main.ts MUST run with --disable-direct-composition. Otherwise the
  //   Electron window has WS_EX_NOREDIRECTIONBITMAP (no GDI redirection
  //   surface) and ANY reparented GDI window — child or popup — composites
  //   as a black hole (PrintWindow(WM_PRINT) still drew the full DS UI, so
  //   only DWM composition was broken).
  // - Do NOT call SetThreadDpiHostingBehavior(MIXED) around SetParent — it
  //   hard-crashed Electron's UI thread.
  const childStyle = ((style & ~WS_POPUP) | WS_CHILD | WS_CLIPSIBLINGS) >>> 0;
  SetWindowLongPtrW(dsHwnd, GWL_STYLE, childStyle);
  // Host must clip its children or the dashboard's presents keep stomping the
  // DS rect between DS repaints (see WS_CLIPCHILDREN note above). Saved and
  // restored verbatim on undock.
  const hostStyle = styleOf(appHwnd, GWL_STYLE);
  savedHostStyle = hostStyle;
  SetWindowLongPtrW(appHwnd, GWL_STYLE, (hostStyle | WS_CLIPCHILDREN) >>> 0);
  SetParent(dsHwnd, appHwnd);
  docked = true;
  dockedHeightPhys = rect.bottom - rect.top; // first guess: pre-dock height
  repositionDocked(); // bottom strip: full client width, DS's own height
  SetWindowPos(dsHwnd, 0, 0, 0, 0, 0, SWP_APPLY_FRAME);
  // The DS may have re-sized itself during reparent/move — adopt its actual
  // height and re-anchor to the bottom edge.
  const actual = winRect(dsHwnd);
  const actualH = actual.bottom - actual.top;
  if (actualH > 0 && actualH !== dockedHeightPhys) {
    dockedHeightPhys = actualH;
    repositionDocked();
  }

  const sf = screen.getDisplayMatching(hostWindow.getBounds()).scaleFactor;
  heightDip = Math.round(dockedHeightPhys / sf);
  console.log(
    `[dsdock] docked hwnd=${dsHwnd} style 0x${style.toString(16)}->0x${childStyle.toString(16)} ` +
      `heightPhys=${dockedHeightPhys} heightDip=${heightDip} scaleFactor=${sf}`,
  );
  setHover(false);
  pushStatus();
  ensureTimers();
}

// Synchronous restore core (shared by undock/restoreDs; exit paths need sync).
function undockNow(): void {
  if (!docked) return;
  docked = false;
  heightDip = null;
  dockedHeightPhys = 0;
  const s = saved;
  saved = null;
  if (savedHostStyle !== null && appHwnd && IsWindow(appHwnd)) {
    SetWindowLongPtrW(appHwnd, GWL_STYLE, savedHostStyle);
    savedHostStyle = null;
  }
  if (s && dsHwnd && IsWindow(dsHwnd)) {
    SetParent(dsHwnd, 0);
    SetWindowLongPtrW(dsHwnd, GWL_STYLE, s.style);
    SetWindowLongPtrW(dsHwnd, GWL_EXSTYLE, s.exStyle);
    SetWindowPos(
      dsHwnd,
      0, // HWND_TOP
      s.rect.left,
      s.rect.top,
      s.rect.right - s.rect.left,
      s.rect.bottom - s.rect.top,
      SWP_RESTORE_SHOW,
    );
    console.log(`[dsdock] undocked hwnd=${dsHwnd} restored rect=${JSON.stringify(s.rect)}`);
  }
  lastDsRect = null;
  dragSession = false;
  btnWasDown = false;
  pushStatus();
  ensureTimers();
}

export async function undock(): Promise<void> {
  undockNow();
}

// Spawns the real FRC Driver Station detached. __COMPAT_LAYER (both verified
// on-machine, 2026-07-11):
// - RunAsInvoker: the DS manifest requests "highestAvailable", so a plain
//   CreateProcess from a non-elevated process fails with
//   ERROR_ELEVATION_REQUIRED (EACCES). Run it as-invoker, no UAC prompt.
// - HighDpiAware: the DS is DPI-unaware; on a >100% display Windows gives it
//   a DWM-virtualized surface that does NOT composite once it becomes a child
//   of our per-monitor-DPI-aware window (docked DS renders invisible).
//   System-DPI-aware skips virtualization so the docked DS actually paints.
//   Known limit: a DS launched OUTSIDE this app (normal Start-menu launch) is
//   virtualized and will dock invisible on high-DPI screens — use Launch DS.
export async function launchDs(): Promise<void> {
  const child = spawn(DS_EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker HighDpiAware' },
  });
  child.unref();
}

// Idempotent + synchronous. Re-parents the DS back to the desktop if docked.
// main.ts calls this on before-quit / window closed / process exit / uncaughtException.
export function restoreDs(): void {
  try {
    undockNow();
  } catch {
    // never throw on exit paths
  }
}

// Test-only (HELIOS_DOCK_TEST harness in main.ts): raw Win32 readbacks so the
// harness can assert re-parenting without duplicating koffi bindings.
export function __testProbe(): {
  appHwnd: number;
  dsHwnd: number;
  found: boolean;
  docked: boolean;
  dsIsWindow: boolean;
  dsParent: number;
  dsTreeParent: number;
  dsStyle: number;
  dsExStyle: number;
  dsRect: Rect | null;
  appClientScreen: Rect;
  scaleFactor: number;
} {
  const c = appClientRect(appHwnd);
  const o = clientOriginScreen(appHwnd);
  const alive = dsHwnd !== 0 && !!IsWindow(dsHwnd);
  return {
    appHwnd,
    dsHwnd,
    found,
    docked,
    dsIsWindow: alive,
    dsParent: alive ? Number(GetParent(dsHwnd)) : 0,
    // True window-tree parent (GA_PARENT): style-agnostic containment check.
    // For a top-level window this is the desktop window, not 0.
    dsTreeParent: alive ? Number(GetAncestor(dsHwnd, GA_PARENT)) : 0,
    dsStyle: alive ? styleOf(dsHwnd, GWL_STYLE) : 0,
    dsExStyle: alive ? styleOf(dsHwnd, GWL_EXSTYLE) : 0,
    dsRect: alive ? winRect(dsHwnd) : null,
    appClientScreen: { left: o.x, top: o.y, right: o.x + c.right, bottom: o.y + c.bottom },
    scaleFactor:
      hostWindow && !hostWindow.isDestroyed()
        ? screen.getDisplayMatching(hostWindow.getBounds()).scaleFactor
        : 1,
  };
}

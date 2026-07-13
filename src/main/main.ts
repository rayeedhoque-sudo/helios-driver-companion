// Main process: window, settings persistence, DS-dock wiring, IPC.
// Settings file I/O and IPC channel names are FROZEN (see ARCHITECTURE.md).
import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Settings, Station } from '../renderer/store';
import {
  initDsDock,
  setZoneRect,
  dock,
  undock,
  launchDs,
  restoreDs,
  __testProbe,
  type DsStatus,
} from './dsdock';
import { initDeploy, startDeploy, cancelDeploy, getStatus as getDeployStatus, killDeployOnQuit } from './deploy';

// M3 DS dock requirement: a reparented GDI window (the LabVIEW Driver
// Station) can only composite inside our window if the window has a classic
// GDI redirection surface. Chromium's DirectComposition windows carry
// WS_EX_NOREDIRECTIONBITMAP, which renders any embedded GDI window as a
// black hole (verified on-machine 2026-07-11). Costs a little present
// latency; fine for a dashboard.
app.commandLine.appendSwitch('disable-direct-composition');

// Exactly ONE instance may run: dsdock's dock state is per-process, and a second
// copy scanning for the same OS-level DS window would fight the first over
// SetParent and corrupt the saved pre-dock style/rect (breaking undock restore).
// app.exit() here is safe — nothing is wired or docked yet.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const DEFAULTS: Settings = {
  ntHost: '10.97.4.2',
  simMode: false,
  limelightHost: '10.97.4.11',
  station: 'B1',
};

const VALID_STATIONS: Station[] = ['R1', 'R2', 'R3', 'B1', 'B2', 'B3'];

let settingsPath = '';
let settings: Settings = { ...DEFAULTS };
let mainWindow: BrowserWindow | null = null;
let lastDsStatus: DsStatus = { found: false, docked: false, heightDip: null, exeRunning: false, dsStation: null };

// --- settings persistence ---------------------------------------------------
function loadSettings(): void {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    // Strip a UTF-8 BOM (Notepad/PowerShell add one) — JSON.parse rejects it.
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')) as Partial<Settings>;
    settings = sanitize({ ...DEFAULTS, ...parsed });
  } catch {
    settings = { ...DEFAULTS };
  }
}

function sanitize(s: Settings): Settings {
  return {
    ntHost: typeof s.ntHost === 'string' && s.ntHost ? s.ntHost : DEFAULTS.ntHost,
    simMode: Boolean(s.simMode),
    limelightHost:
      typeof s.limelightHost === 'string' && s.limelightHost ? s.limelightHost : DEFAULTS.limelightHost,
    station: VALID_STATIONS.includes(s.station) ? s.station : DEFAULTS.station,
    // Pass the dockview layout through untouched (opaque to main). Without this the
    // fixed-shape return would strip it and the layout would never persist.
    layout: s.layout,
  };
}

function saveSettings(patch: Partial<Settings>): Settings {
  settings = sanitize({ ...settings, ...patch });
  try {
    // Write-temp-then-rename: a crash mid-write must never leave settings.json
    // truncated (loadSettings would silently fall back to defaults, losing the
    // saved layout/hosts). rename on the same volume is atomic on Windows/NTFS.
    const tmp = settingsPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    renameSync(tmp, settingsPath);
  } catch (err) {
    console.error('[main] failed to persist settings:', err);
  }
  return settings;
}

// --- window -----------------------------------------------------------------
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1600,
    minHeight: 900,
    backgroundColor: '#0a0e15',
    show: false,
    // build.mjs copies assets/ into dist/assets/ alongside this file (dist/main.cjs),
    // so __dirname-relative resolves the same in dev and packaged layouts.
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox left at Electron default.
    },
  });
  mainWindow = win;

  win.maximize();
  win.once('ready-to-show', () => win.show());

  // Surface renderer console output on stdout (survives API-shape changes across Electron versions).
  win.webContents.on(
    'console-message',
    (event: unknown, level?: unknown, message?: unknown, line?: unknown, sourceId?: unknown) => {
      const e = event as { message?: string; level?: unknown; lineNumber?: number; sourceId?: string };
      const msg = typeof message === 'string' ? message : e?.message ?? '';
      const lvl = typeof level === 'number' || typeof level === 'string' ? level : e?.level;
      const src = typeof sourceId === 'string' ? sourceId : e?.sourceId ?? '';
      const ln = typeof line === 'number' ? line : e?.lineNumber ?? '';
      console.log(`[renderer${lvl != null ? ':' + lvl : ''}] ${msg} (${src}:${ln})`);
    },
  );

  // Load / crash diagnostics (useful for every milestone).
  win.webContents.on('did-finish-load', () => console.log('[main] renderer did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[main] did-fail-load ${code} ${desc} ${url}`),
  );
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('[main] render-process-gone', details),
  );

  // Wire DS dock: cache + forward status, forward hover events to the renderer.
  initDsDock(
    win,
    (s) => {
      lastDsStatus = s;
      win.webContents.send('ds:status-changed', s);
    },
    (h) => win.webContents.send('ds:hover', h),
  );

  // Wire deploy: forward child-process output/done events to the renderer.
  initDeploy(
    (chunk) => win.webContents.send('deploy:output', chunk),
    (code) => win.webContents.send('deploy:done', code),
  );

  void win.loadFile(path.join(__dirname, 'index.html'));

  // M3 regression harness (see ARCHITECTURE.md § Testing). Kept on purpose.
  const dockTestMode = process.env.HELIOS_DOCK_TEST;
  if (dockTestMode) {
    win.webContents.once('did-finish-load', () => void runDockTest(win, dockTestMode));
  }

  win.on('closed', () => {
    restoreDs();
    mainWindow = null;
  });
}

// --- HELIOS_DOCK_TEST harness ------------------------------------------------
// Modes: '1'   = find/launch DS → dock → assert → resize → assert → undock →
//               assert → quit (post-quit DS survival is asserted externally);
//        'kill' = find/launch DS → dock → hold forever (harness taskkill /F's
//                 us to exercise the crash path);
//        'status' = wait for the first scans, log DsStatus, quit (crash-
//                   recovery "Restart DS" precondition check).
function dockAssert(name: string, ok: boolean, detail: string): void {
  if (!ok) process.exitCode = 1;
  console.log(`[docktest] ${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

async function runDockTest(win: BrowserWindow, mode: string): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    if (mode === 'status') {
      await sleep(8000);
      console.log(`[docktest] status ${JSON.stringify(lastDsStatus)}`);
      app.quit();
      return;
    }

    // Ensure the DS window exists (launch if needed) — LabVIEW starts slowly.
    if (!lastDsStatus.found) {
      void launchDs();
      const t0 = Date.now();
      while (!lastDsStatus.found && Date.now() - t0 < 90_000) await sleep(500);
    }
    dockAssert('ds-found', lastDsStatus.found, JSON.stringify(lastDsStatus));
    if (!lastDsStatus.found) {
      app.quit();
      return;
    }

    const pre = __testProbe();
    console.log(`[docktest] pre-dock probe ${JSON.stringify(pre)}`);
    await dock();
    await sleep(750);
    const p1 = __testProbe();
    console.log(`[docktest] post-dock probe ${JSON.stringify(p1)}`);
    // GA_PARENT is the true tree parent regardless of WS_CHILD/WS_POPUP.
    dockAssert(
      'parent-is-app',
      p1.dsTreeParent === p1.appHwnd,
      `treeParent=${p1.dsTreeParent} getParent=${p1.dsParent} app=${p1.appHwnd}`,
    );
    const inside =
      !!p1.dsRect &&
      p1.dsRect.left >= p1.appClientScreen.left &&
      p1.dsRect.top >= p1.appClientScreen.top &&
      p1.dsRect.right <= p1.appClientScreen.right &&
      p1.dsRect.bottom <= p1.appClientScreen.bottom;
    dockAssert(
      'rect-inside-app-client',
      inside,
      `ds=${JSON.stringify(p1.dsRect)} appClient=${JSON.stringify(p1.appClientScreen)}`,
    );

    if (mode === 'kill') {
      console.log(`[docktest] holding docked — hard-kill me now (electron pid ${process.pid})`);
      return; // stay alive; the harness taskkill /F's this pid
    }

    win.unmaximize();
    win.setContentSize(1620, 920);
    // The DS converges asynchronously (LabVIEW self-restore vs the reposition
    // burst) — poll up to 3 s for the settled rect instead of one fixed probe.
    const followsOk = (p: ReturnType<typeof __testProbe>): boolean =>
      !!p.dsRect &&
      p.dsRect.left === p.appClientScreen.left &&
      p.dsRect.right === p.appClientScreen.right &&
      p.dsRect.bottom === p.appClientScreen.bottom;
    let p2 = __testProbe();
    for (let i = 0; i < 15 && !followsOk(p2); i++) {
      await sleep(200);
      p2 = __testProbe();
    }
    console.log(`[docktest] post-resize probe ${JSON.stringify(p2)}`);
    dockAssert(
      'rect-follows-resize',
      followsOk(p2),
      `ds=${JSON.stringify(p2.dsRect)} appClient=${JSON.stringify(p2.appClientScreen)}`,
    );

    await undock();
    await sleep(500);
    const p3 = __testProbe();
    console.log(`[docktest] post-undock probe ${JSON.stringify(p3)}`);
    dockAssert(
      'parent-restored',
      p3.dsParent === 0 && p3.dsTreeParent !== p3.appHwnd,
      `getParent=${p3.dsParent} treeParent=${p3.dsTreeParent} (desktop expected)`,
    );
    dockAssert(
      'style-restored',
      p3.dsStyle === pre.dsStyle && p3.dsExStyle === pre.dsExStyle,
      `style=0x${p3.dsStyle.toString(16)} want=0x${pre.dsStyle.toString(16)} ` +
        `ex=0x${p3.dsExStyle.toString(16)} want=0x${pre.dsExStyle.toString(16)}`,
    );
    // Height is the DS's own business (LabVIEW self-sizes, and it re-measures
    // when DPI hosting changes) — assert position + width, report height.
    const rectRestored =
      !!p3.dsRect &&
      !!pre.dsRect &&
      p3.dsRect.left === pre.dsRect.left &&
      p3.dsRect.top === pre.dsRect.top &&
      p3.dsRect.right === pre.dsRect.right;
    dockAssert('rect-restored', rectRestored, `ds=${JSON.stringify(p3.dsRect)} saved=${JSON.stringify(pre.dsRect)}`);
    console.log('[docktest] done — quitting');
    app.quit();
  } catch (err) {
    process.exitCode = 1;
    console.error('[docktest] FAIL harness error:', err);
    app.quit();
  }
}

// --- IPC --------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => saveSettings(patch));

  ipcMain.handle('ds:status', () => lastDsStatus);
  ipcMain.handle('ds:dock', () => dock());
  ipcMain.handle('ds:undock', () => undock());
  ipcMain.handle('ds:launch', () => launchDs());
  ipcMain.on('ds:zone-rect', (_e, rectDip: { x: number; y: number; w: number; h: number }) =>
    setZoneRect(rectDip),
  );

  ipcMain.handle('deploy:start', () => startDeploy());
  ipcMain.handle('deploy:cancel', () => cancelDeploy());
  ipcMain.handle('deploy:status', () => getDeployStatus());
}

// --- lifecycle + restore safety hooks --------------------------------------
app.whenReady().then(() => {
  loadSettings();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  restoreDs();
  if (process.platform !== 'darwin') app.quit();
});

// restoreDs is idempotent + synchronous; call it on every exit path.
app.on('before-quit', () => {
  restoreDs();
  killDeployOnQuit(); // best-effort tree kill if a deploy is still running
});
process.on('exit', () => restoreDs());
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
  // restoreDs() is synchronous, so the DS is safely un-parented BEFORE exit
  // destroys our HWND. Then exit: registering this handler suppresses Node's
  // default crash-exit, and soldiering on in an unknown state is worse than a
  // clean visible death.
  restoreDs();
  killDeployOnQuit();
  app.exit(1);
});

# Helios Driver Companion — Architecture

Single-window 1920×1080 Electron + TypeScript driver dashboard for FRC Team 9704.
The UI is a VS Code-style docking layout (`dockview-core`): every panel is a
draggable/closable/splittable tab registered in `panels-registry.ts` (contract
FROZEN — see that section). Follow-up agents fill panel **internals only** (their
`mount` implementations) and must not change registry ids or any signature below.

## Build & run

- `npm run typecheck` — `tsc --noEmit`.
- `npm run build` — `node build.mjs` (esbuild). Emits `dist/{main.cjs, preload.cjs,
  renderer.js, index.html, style.css, dockview.css, assets/}`.
- `npm start` — build then launch Electron. (`npx electron .` runs the last build.)
- esbuild entry points: `src/main/main.ts`→`dist/main.cjs` (node/cjs, external
  `electron`,`koffi`), `src/main/preload.ts`→`dist/preload.cjs` (same), and
  `src/renderer/app.ts`→`dist/renderer.js` (browser/iife, bundles uplot +
  dockview-core + the vendored NT4 client). Static files + `assets/` are copied
  verbatim. `dockview.css` is copied from `node_modules/dockview-core/dist/styles/`
  by build.mjs (unlike uPlot's CSS, which is hand-inlined in style.css) and loaded
  BEFORE style.css so the app's `.dockview-theme-dark` variable overrides win.

## File map / ownership

| File | Status | Role |
|------|--------|------|
| `src/main/main.ts` | wiring frozen | window, settings I/O (passes `layout` through; atomic tmp+rename write), IPC, DS hooks, single-instance lock |
| `src/main/dsdock.ts` | done | Win32 SetParent DS docking |
| `src/main/preload.ts` | frozen | `window.companion` bridge |
| `src/renderer/app.ts` | done | bootstrap, dockview shell, layout persistence, top-bar/dock wiring |
| `src/renderer/panels-registry.ts` | **contract FROZEN** | panel id/title/mount registry (see below) |
| `src/renderer/store.ts` | done | settings pub-sub cache; owns `Settings`/`Station` |
| `src/renderer/nt.ts` | done | NT4 client + `TOPICS` |
| `src/renderer/field.ts` | done | field render + steer-desync watch; `mountLaptopMap` = Orientation radar (implemented) |
| `src/renderer/graphs.ts` | done | two uPlot panels (voltage / current) |
| `src/renderer/panels.ts` | done | power, vision-link, mechanisms, auto-chooser panels |
| `src/renderer/limelight.ts` | done | MJPEG stream + overlay panel |
| `src/renderer/deploy.ts` | done | deploy panel (button, live log, status) |
| `src/main/deploy.ts` | done | `gradlew deploy` child-process spawn/cancel/quit-kill |

**Type ownership (single source each):** `Settings`,`Station` → `store.ts`;
`DsStatus` → `dsdock.ts`; `CompanionApi` → `preload.ts`; `ConnState`,`TOPICS` →
`nt.ts`. main.ts/preload.ts import `Settings` type-only from `store.ts` (erased at
bundle time — no runtime coupling). `window.companion` is globally augmented in
`app.ts`.

## Settings (main process owns file I/O at `app.getPath('userData')/settings.json`)

```ts
type Settings = {
  ntHost: string; simMode: boolean; limelightHost: string; station: Station;
  layout?: unknown; // opaque dockview SerializedDockview blob — see Layout persistence
};
type Station = 'R1'|'R2'|'R3'|'B1'|'B2'|'B3';
// defaults: { ntHost:'10.97.4.2', simMode:false, limelightHost:'10.97.4.11', station:'B1' }
// effective NT host = simMode ? '127.0.0.1' : ntHost  (computed in renderer, app.ts)
```

main.ts sanitizes on load/save (bad JSON → defaults; unknown station → default;
`layout` passes through UNVALIDATED — the renderer owns restore-failure fallback).

## Preload bridge: `window.companion` (CompanionApi)

```ts
interface CompanionApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;   // merge + persist + return full
  ds: {
    status(): Promise<DsStatus>;
    dock(): Promise<void>;
    undock(): Promise<void>;
    launch(): Promise<void>;                                    // spawn DriverStation.exe
    setZoneRect(rectDip: {x:number;y:number;w:number;h:number}): void; // dock-strip rect, window DIP
    onStatus(cb: (s: DsStatus) => void): void;
    onHover(cb: (hovering: boolean) => void): void;             // drag-over-zone highlight
  };
  deploy: {
    start(): Promise<DeployActionResult>;
    cancel(): Promise<DeployActionResult>;
    status(): Promise<DeployStatus>;                            // for remount: re-render current state
    onOutput(cb: (chunk: string) => void): void;                // raw stdout/stderr text, as it arrives
    onDone(cb: (code: number|null) => void): void;               // fires once when the process exits
  };
}
type DsStatus = {
  found: boolean; docked: boolean; heightDip: number|null; exeRunning: boolean;
  dsStation: 'R1'|'R2'|'R3'|'B1'|'B2'|'B3'|null; // see "dsdock.ts" § DS station below
};
type DeployPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled';
type DeployStatus = { phase: DeployPhase; startedAt: number|null; exitCode: number|null };
type DeployActionResult = { ok: true } | { ok: false; error: string };
```

## IPC channels

- Invoke (renderer→main→reply): `settings:get`, `settings:save`, `ds:status`,
  `ds:dock`, `ds:undock`, `ds:launch`, `deploy:start`, `deploy:cancel`, `deploy:status`.
- Send (renderer→main, fire-and-forget): `ds:zone-rect`.
- Events (main→renderer): `ds:status-changed`, `ds:hover`, `deploy:output` (arg:
  `chunk: string`), `deploy:done` (arg: `code: number|null`).

main.ts caches the last `DsStatus` pushed by dsdock's `onStatus` callback and
returns it for `ds:status`. Deploy has no such main-side cache beyond
`deploy.ts`'s own `phase`/`startedAt`/`exitCode` — `deploy:status` reads it
straight from there (see next section).

## deploy.ts (main) + deploy panel (renderer)

`src/main/deploy.ts` owns the `gradlew deploy` child process; `main.ts` only
wires its callbacks to `webContents.send` and its actions to `ipcMain.handle`
(same shape as dsdock.ts's wiring). Exported signatures:

```ts
export type DeployPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled';
export type DeployStatus = { phase: DeployPhase; startedAt: number|null; exitCode: number|null };
export type DeployActionResult = { ok: true } | { ok: false; error: string };
export function initDeploy(onOutput: (chunk: string) => void, onDone: (code: number|null) => void): void;
export function getStatus(): DeployStatus;
export function startDeploy(): DeployActionResult;              // single-flight; spawns cmd.exe /c gradlew.bat deploy --no-daemon
export function cancelDeploy(): Promise<DeployActionResult>;    // taskkill /PID <pid> /T /F (whole tree)
export function killDeployOnQuit(): void;                       // same taskkill, fire-and-forget
```

Spawn is a FIXED argv — `cmd.exe /c C:\FRC\Helios-2026\gradlew.bat deploy`, cwd
`C:\FRC\Helios-2026`, `shell:false` — no user-controllable strings anywhere near
it, so nothing is templated in. The batch file is referenced by its full
hardcoded path rather than the bare `gradlew.bat` the spec sketch suggested:
this machine has `NoDefaultCurrentDirectoryInExePath=1` set (a Windows
hardening setting), which disables `cmd.exe`'s implicit current-directory
executable search, so a bare filename silently fails to resolve even with the
right `cwd` — confirmed on-machine 2026-07-11 (`'gradlew.bat' is not
recognized...`, exit 1, ~instantly). The absolute path sidesteps that env var
entirely and is still a fixed constant, not user input. `startDeploy()` rejects a second call while `phase==='running'`
(the renderer also disables the button, this is the server-side backstop).
The build runs with `--no-daemon` so it lives entirely inside this process tree —
a gradle daemon (its own detached JVM, possibly pre-existing from editor builds)
would keep building/deploying after the client dies, making Cancel a no-op.
`cancelDeploy()`/`killDeployOnQuit()` then kill the whole tree via
`taskkill /T /F` (a plain `child.kill()` would only hit `cmd.exe`). `killDeployOnQuit()` is wired additively into main.ts's
existing `before-quit` handler, alongside `restoreDs()`.

`src/renderer/deploy.ts` keeps its log buffer (capped ~2000 lines) and last-known
`DeployStatus` in MODULE scope (not per-mount), same pattern as panels.ts's
cached `lastNames`/`lastOptions`: `deploy:output`/`deploy:done` are subscribed
once behind an `ensureSubs()` guard, so they keep updating the buffer even while
the panel tab is closed. `mountDeploy(container)` rebuilds the DOM fresh every
open and immediately calls `deploy:status` to re-sync the button/status-line/log
render to whatever actually happened while it was unmounted. Styling is a single
`<style id="dpl-styles">` injected into `document.head` once (guarded, so reopen
doesn't duplicate it) — deploy.ts does not touch `style.css`, which is owned by
the field/map + limelight agents' concurrent work.

## dsdock.ts (M3 replaces internals only; main.ts wiring stays)

```ts
export type DsStatus = {
  found:boolean; docked:boolean; heightDip:number|null; exeRunning:boolean;
  dsStation: 'R1'|'R2'|'R3'|'B1'|'B2'|'B3'|null;
};
export function initDsDock(win: BrowserWindow, onStatus:(s:DsStatus)=>void, onHover:(h:boolean)=>void): void;
export function setZoneRect(rectDip: {x:number;y:number;w:number;h:number}): void;
export function dock(): Promise<void>;
export function undock(): Promise<void>;
export function launchDs(): Promise<void>;   // IMPLEMENTED: spawns DriverStation.exe detached
export function restoreDs(): void;           // idempotent, synchronous
```

`restoreDs()` is wired in main.ts to `before-quit`, window `closed`,
`process.on('exit')`, and `uncaughtException`. Stub status is all-false/null.
DS exe path: `C:\Program Files (x86)\FRC Driver Station\DriverStation.exe`.

**DS station (local source):** the DS persists its team-station dropdown to
`C:\Users\Public\Documents\FRC\FRC DS Data Storage.ini` (`TeamStation` key
under `[Setup]`, value `0`–`5`), independent of whether the DS process is
currently running — a saved choice is still the DS's choice, so `dsStation`
is populated whenever that ini exists and parses, docked or not. Mapping
(FRC DS alliance-station encoding): `0=R1 1=R2 2=R3 3=B1 4=B2 5=B3` — **not
yet spot-checked live**; verify at the next DS session by flipping the DS's
station dropdown and watching this value change. The ini is parsed as
untrusted text (one regex pulling just the `TeamStation` key, tolerant of
quotes/whitespace/CRLF, never eval'd). Refresh is piggybacked on the existing
2 s scan tick (`scanTick()`, plus once at `initDsDock()` startup): a
`statSync` runs every tick, but the file is only re-read when its mtime
moved. **Caveat:** LabVIEW appears to write this ini on DS exit, not live as
the dropdown changes — while the DS is open, `dsStation` reflects the last
*saved* selection, which can lag the on-screen selection by one session. This
is accepted: NT `/FMSInfo` is the live path once the robot is connected, and
the renderer prioritizes it over this ini-derived value; this field is a
fallback for "what does the DS have saved" when NT isn't available (robot
off/disconnected). `dsStation` is `null` when the ini is missing, unreadable,
or its `TeamStation` value is out of the `0`–`5` range.

## nt.ts (M1 replaces internals only)

```ts
export type ConnState = { connected: boolean; rttMs: number|null };
export function ntConnect(host: string): void;                 // (re)connect, idempotent on same host
export function onValue(topic: string, cb: (value: unknown, timestampUs: number) => void): () => void;
export function ntPublish(topic: string, typeStr: string, value: unknown): void;
export function onConnection(cb: (s: ConnState) => void): () => void; // returns unsubscriber
export function getConnState(): ConnState;
export function decodeSwerveModuleStates(raw: Uint8Array): { speedMps:number; angleRad:number }[]; // IMPLEMENTED
export const TOPICS = {
  pose: '/Pose/robotPose',                    // double[3] {x m, y m, deg}, blue-origin
  moduleStates: '/DriveState/ModuleStates',   // struct:SwerveModuleState[] raw
  moduleTargets: '/DriveState/ModuleTargets', // struct:SwerveModuleState[] raw (commanded)
  isRedAlliance: '/FMSInfo/IsRedAlliance', stationNumber: '/FMSInfo/StationNumber',
  fmsControl: '/FMSInfo/FMSControlData',      // int control word (0x01 enabled, 0x20 DS attached)
  autoChooser: '/SmartDashboard/Auto Chooser',// subkeys /options /default /active /selected
  telemetry: '/CompanionTelemetry',           // subkeys /names /stator /supply /temp /voltage
  limelight: '/limelight-knight',             // subkeys /tv /tl /cl /hb /botpose
} as const;
```

`decodeSwerveModuleStates` is a pure fn: 16 bytes/module, f64 LE speed then f64 LE
angle. Wrapper behaviors: connection listeners are re-notified every 1 s while
connected (the RTT number only exists after the first timestamp round-trip, which
lands AFTER onConnect fires); `ntPublish` caches the last value per topic and
re-sends it on every (re)connect (`addSample` silently no-ops while the socket
isn't OPEN); every NT4_Client callback guards `client === c` so a torn-down
client's late socket events can't reach the live app. The vendored NT4.ts carries
three LOCAL FIX blocks (unconditional socket close in `disconnect()`, a source
guard in `ws_onMessage`, and `continue`-not-`return` in the msgpack batch loop) —
preserve them if re-vendoring.

## store.ts (implemented)

```ts
export function initStore(initial: Settings): void;
export function getSettings(): Settings;
export async function updateSettings(patch: Partial<Settings>): Promise<void>; // saveSettings→cache→notify
export function onSettings(cb: (s: Settings) => void): void;  // fires once immediately if initialized
```

## Panel registry — `panels-registry.ts` (contract FROZEN)

Every dashboard panel is a dockview tab described by one registry entry:

```ts
interface PanelDef {
  id: string;                            // dockview panel id + layout key. NEVER rename.
  title: string;                         // tab label
  mount(container: HTMLElement): void;   // populate the given fresh, empty element
}
export const PANELS: readonly PanelDef[];
export function getPanelDef(id: string): PanelDef | undefined;
```

Rules for follow-up agents:

- **Replace a panel** by changing its `mount` implementation in the owning module;
  the registry row (id/title) stays. **Add a panel** by adding a row + a mount.
- `mount` is called once per *open* (boot restore, "+ Panels" reopen), so it must
  rebuild its DOM into the container from scratch and be safely re-invokable.
  One-shot work (NT `onValue` subscriptions, `setInterval`s) goes behind a
  module-level `ensure*` guard — see `panels.ts` — otherwise reopening a panel
  duplicates subscriptions. Retained NT values (names/options) won't replay to a
  rebuilt DOM: cache them module-level and re-apply in mount.
- Panels in hidden tabs stay mounted but DETACHED from the document (dockview's
  default renderer). Timers keep running; ResizeObservers fire on re-attach —
  size-dependent code must tolerate 0×0 and recover via its ResizeObserver.
- Current ids: `limelight`, `field`, `laptop-map` (Orientation radar),
  `graph-voltage`, `graph-current`, `power`, `mechanisms`, `auto-chooser`,
  `vision-link`, `deploy`, `controls` (static Xbox-bindings reference —
  KEEP IN SYNC with RobotContainer.configureBindings(); starts closed).

## Dockview shell + layout persistence (app.ts)

- `createDockview(#dock-root, { theme: {...themeDark, gap: 4}, createComponent })` —
  every component renders a `div.dc-panel` and calls the registry mount on init.
  `window.__dock` exposes the `DockviewApi` (debug/verification hook).
- Tabs drag anywhere, split horizontally/vertically, resize, close (default
  dockview behaviors — no custom code). Theme: vendored `dockview.css` +
  `.dockview-theme-dark` CSS-variable overrides in style.css (Helios dark).
- **Default layout** (`defaultLayout()`): limelight (~40 %) | field | right column
  (~22 %): power / {graph-voltage + graph-current tabs} / {mechanisms + vision-link
  + auto-chooser tabs}. `laptop-map` and `deploy` start closed.
- **Persistence**: `onDidLayoutChange` → debounced 400 ms →
  `updateSettings({ layout: api.toJSON() })`. Boot: `restoreLayout()` tries
  `fromJSON(settings.layout)`, falls back to `defaultLayout()` on ANY error.
- **"+ Panels"** top-bar menu (`#btn-panels` + `#panels-menu`): lists all registry
  panels (dot = open); click focuses an open panel or re-adds a closed one.
- **Reset layout**: `#set-reset-layout` in the settings modal → `defaultLayout()` +
  immediate persist.
- Boot order: `getSettings` → `initStore` → createDockview → restore layout (mounts
  panels) → persistence + menus → top bar / dock strip / NT status wiring →
  `onSettings` drives `ntConnect(effectiveHost)`.

## field.ts

Loads `assets/2026-field.png` (3901×1583), crops the playable field to pixel
corners TL `[524,94]` / BR `[3378,1490]` (field 16.541 m × 8.069 m), letterboxes it
into a canvas it creates inside its panel container, and draws pose, trail, swerve
arrows (actual solid + commanded ModuleTargets ghosts, with a red STEER DESYNC
banner when a driven module's actual direction diverges >25° for >0.7 s), and the
YOU marker (2026 is rotationally symmetric, so Red's station slots mirror Blue's).
There is NO station-mismatch alarm: the picker silently follows /FMSInfo while a
DS is attached (`reconcileFollow`), so an in-app mismatch cannot persist. The
trail clears itself on a >1 m pose jump (auto pose seed / odometry re-zero). The
panel also hosts the station picker overlay (`#station-picker`, panel-created).

- `mountField(container)` — builds canvas + orientation toggle, wires NT subs.
- `mountLaptopMap(container)` — Orientation radar (implemented; registry id kept
  for layout persistence): YOU at ring center, robot glyph at relative
  bearing/distance, manual re-zero + 📍 mark-position knobs.
- `resizeField()` — backing size = element size × devicePixelRatio; draw space is
  CSS px (`ctx.setTransform(dpr,…)`).
- `fieldToCanvas(xM, yM) → {x,y}` — meters (blue-origin, +x→red, +y→left, y=0 at
  bottom) to canvas CSS px.

## DOM ids (in index.html — fixed chrome only; panels build their own DOM)

`#topbar`, `#nt-status` (`.pip` + `.rtt`),
`#btn-panels` + `#panels-menu`, `#btn-dock`, `#btn-launch-ds`, `#btn-settings`,
`#settings-modal` (inputs `#set-nt-host`, `#set-sim-mode`, `#set-limelight-host`,
buttons `#set-reset-layout`, `#set-save`, `#set-cancel`), `#dock-root` (dockview
host), `#dock-strip` (24 px collapsed; `.highlight` grows to 64 px, `.docked`
grows to `var(--ds-height)`). Panel-created ids: `#field-canvas`,
`#station-picker` (6 `button[data-station]`, inside the field panel),
`#limelight-stream`, `#limelight-overlay`.

## Testing — DS dock regression harness (M3, keep)

`HELIOS_DOCK_TEST=<mode> npx electron .` runs a main-process harness after
did-finish-load (safe on a dev laptop; launches/asserts against the real
`DriverStation.exe`, no robot needed). Asserts print as `[docktest] PASS/FAIL`;
any FAIL sets a nonzero exit code. Modes:

- `1` — find DS (launch if missing) → `dock()` → assert tree parent + rect →
  shrink the window → assert the DS tracked it → `undock()` → assert parent /
  style / rect restored → quit. After quit, verify externally (koffi script or
  Tuner) that the DS window is still alive and top-level.
- `kill` — dock, then hold forever; `taskkill /F` the printed electron PID and
  verify: DS *window* destroyed with its parent, `DriverStation.exe` still in
  tasklist (the "Restart DS" hint precondition).
- `status` — wait ~8 s, log the current `DsStatus`, quit. Run after `kill` to
  confirm `{found:false, exeRunning:true}`.

`dsdock.ts` exports test-only `__testProbe()` (raw Win32 readbacks) for this
harness. Hard-won platform notes (all verified on-machine 2026-07-11):
`--disable-direct-composition` is REQUIRED (set in main.ts) or the reparented
GDI DS composites as a black hole; the DS is launched with
`__COMPAT_LAYER=RunAsInvoker HighDpiAware` (manifest wants elevation; DPI
virtualization also breaks docked compositing — a DS launched outside the app
docks invisible on >100% displays); never call SetThreadDpiHostingBehavior on
Electron's UI thread (hard crash). Human checklist (not automatable here):
real drag-into-strip gesture, keyboard input (Space/Enter E-Stop!) reaching
the docked DS, and the cosmetic smear band at the DS's bottom edge; also
spot-check the `dsStation` ini mapping (0=R1…5=B3 — flip the DS's station
dropdown, exit the DS, and confirm the value read from `FRC DS Data
Storage.ini` matches what was selected).

## Layout / window

CSS grid rows `[44px topbar | 1fr #dock-root | dock-strip]`. Top bar and dock
strip are FIXED chrome — the embedded Driver Station is a native Win32 window
floating over our content, so the strip must stay a reserved band whose rect is
reported via `ds.setZoneRect` (ResizeObserver + window resize in app.ts; logged as
`[dock-strip] zone rect …`). Everything between is the dockview dock. BrowserWindow:
maximized, min 1600×900, `contextIsolation:true`, `nodeIntegration:false`, sandbox
at Electron default. Renderer console output is mirrored to main-process stdout.

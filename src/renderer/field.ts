// Field render (M2). Draws the static field plus live robot pose, fading pose
// trail, per-module swerve arrows, and a "YOU" station marker. Two orientations:
// full-field (landscape, blue-origin) and driver-perspective (portrait, alliance
// wall at the bottom).
//
// This module owns TWO registry panels that share the same pose/station data flow:
//   - `field`      (mountField)      — the tactical field view above. It ALSO hosts the
//                                       driver-station picker (a floating overlay at the
//                                       field's top edge — moved here out of the top bar)
//                                       plus its follow-the-DS lock.
//   - `laptop-map` (mountLaptopMap)  — an ORIENTATION radar (id kept for layout
//                                       persistence): no field graphic — YOU at the ring
//                                       center, the robot glyph orbiting by its relative
//                                       bearing/distance (so "behind you" is drawable) and
//                                       rotating with its heading, with manual calibration
//                                       knobs (re-zero FORWARD, 📍 mark position).
// The station "single source of truth" is the store (`settings.station`). Live NT
// /FMSInfo drives it — and locks the picker — ONLY while the robot reports a Driver
// Station attached (see reconcileFollow): an unattended roboRIO publishes the boot
// defaults (Red 1), and the DS's local ini is only written on DS exit, so neither may
// override manual picking.
//
// Everything overlaid on the field is positioned in FIELD METERS and mapped through
// fieldToCanvasAt(), so rotation AND the field->canvas reflection are handled once,
// correctly, for all modes. The exported fieldToCanvas/resizeField API is preserved.
import { onSettings, getSettings, updateSettings, type Station } from './store';
import { onValue, onConnection, decodeSwerveModuleStates, TOPICS } from './nt';

// Authoritative 2026 REBUILT field size (WPILib 2026-rebuilt-welded.json). The image
// crop below was calibrated against the field PNG's own metadata (16.535) — the 6 mm
// disagreement is sub-pixel at any panel size; poses live in the 16.541 frame.
const FIELD_W_M = 16.541;
const FIELD_H_M = 8.069;
// Playable-field pixel crop within 2026-field.png (3901x1583), from 2026-rebuilt.json.
const CROP = { sx: 524, sy: 94, sw: 3378 - 524, sh: 1490 - 94 };

// Inset (CSS px) reserved on every side of the canvas so wall-edge decorations (the
// YOU marker + its label, the laptop icon) always draw fully inside the bounds, in
// every mode and at every station. Applied inside computeLayout so all callers inherit it.
const MARGIN = 18;

// ---- pure geometry (DOM-free; exported for the geometry self-check) -----------
export type FieldMode = 'full' | 'driverBlue' | 'driverRed';
export type Layout = { mode: FieldMode; s: number; ox: number; oy: number; cssW: number; cssH: number };

// Letterbox the field into a canvas of cssW x cssH, leaving a MARGIN-px inset on all
// sides. Full mode is landscape; both driver modes are portrait (field's long axis is
// vertical). Scale is fit to the inset area; the field is then centred in the FULL
// canvas, so ox/oy are always >= MARGIN (the guarantee the clipping fix relies on).
export function computeLayout(mode: FieldMode, cssW: number, cssH: number): Layout {
  const portrait = mode !== 'full';
  const wd = portrait ? FIELD_H_M : FIELD_W_M; // display width in meters
  const hd = portrait ? FIELD_W_M : FIELD_H_M; // display height in meters
  const availW = Math.max(1, cssW - 2 * MARGIN);
  const availH = Math.max(1, cssH - 2 * MARGIN);
  const s = Math.min(availW / wd, availH / hd);
  return { mode, s, ox: (cssW - wd * s) / 2, oy: (cssH - hd * s) / 2, cssW, cssH };
}

// Meters (blue-origin: +x toward red wall, +y toward blue's left, y=0 at blue's
// right corner) -> canvas CSS px. Driver modes rotate so the picked wall is at the
// bottom: Blue = +x up (image rotated 90deg CCW), Red = -x up (90deg CW). Both flip
// left/right per the driver's own facing, so the transforms carry a reflection.
export function fieldToCanvasAt(l: Layout, xM: number, yM: number): { x: number; y: number } {
  switch (l.mode) {
    case 'driverBlue':
      return { x: l.ox + (FIELD_H_M - yM) * l.s, y: l.oy + (FIELD_W_M - xM) * l.s };
    case 'driverRed':
      return { x: l.ox + yM * l.s, y: l.oy + xM * l.s };
    default: // full
      return { x: l.ox + xM * l.s, y: l.oy + (FIELD_H_M - yM) * l.s };
  }
}

// Canvas-space angle (for ctx.rotate) of a field-space direction, derived numerically
// so it stays correct under each mode's rotation+reflection without per-mode matrices.
function fieldDirToCanvasAngle(l: Layout, xM: number, yM: number, angRad: number): number {
  const a = fieldToCanvasAt(l, xM, yM);
  const b = fieldToCanvasAt(l, xM + Math.cos(angRad) * 0.5, yM + Math.sin(angRad) * 0.5);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// ---- shared data (both panels read these) ------------------------------------
type Pose = { x: number; y: number; headingDeg: number };
let pose: Pose | null = null;
const TRAIL_MAX = 200; // ~10 s at telemetry rate
const trail: Pose[] = [];
let modules: { speedMps: number; angleRad: number }[] = [];
let moduleTargets: { speedMps: number; angleRad: number }[] = [];
let pickedStation: Station = 'B1';

// ---- steer-desync watch (ModuleTargets vs ModuleStates) -----------------------
// A sustained gap between where a module is COMMANDED to point and where it actually
// points = dead steer motor / wrong CANcoder offset — visible in seconds during a
// pit check instead of "the robot drives weird". Only judged while the module is
// actually being driven (|target speed| >= threshold).
const DESYNC_MIN_SPEED = 0.15; // m/s — below this the module angle is meaningless
const DESYNC_RAD = (25 * Math.PI) / 180;
const DESYNC_HOLD_MS = 700; // must persist this long before flagging
const MODULE_LABELS = ['FL', 'FR', 'BL', 'BR'];
const desyncSince: (number | null)[] = [null, null, null, null];
const desyncActive: boolean[] = [false, false, false, false];

// Direction of travel a state commands, folding reversed speed into the angle so a
// ±180°-optimized target and its unflipped actual compare as equal.
function moduleDir(m: { speedMps: number; angleRad: number }): number {
  return m.angleRad + (m.speedMps < 0 ? Math.PI : 0);
}

function updateDesync(): void {
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    const t = moduleTargets[i];
    const s = modules[i];
    let bad = false;
    if (t && s && Math.abs(t.speedMps) >= DESYNC_MIN_SPEED) {
      // Shortest angular distance between commanded and actual direction.
      let d = moduleDir(t) - moduleDir(s);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      bad = Math.abs(d) > DESYNC_RAD;
    }
    if (!bad) {
      desyncSince[i] = null;
      desyncActive[i] = false;
      continue;
    }
    if (desyncSince[i] == null) desyncSince[i] = now;
    const active = now - (desyncSince[i] as number) > DESYNC_HOLD_MS;
    if (active && !desyncActive[i]) console.warn(`[field] steer desync on ${MODULE_LABELS[i]}`);
    desyncActive[i] = active;
  }
}

// Swerve module corner offsets from robot center, meters — from TunerConstants:
// XPos ±13.375 in (front/back), YPos ±8.375 in (left/right). The track is NOT square.
const MOD_OFFSET_X = 0.34; // front/back (+x = front)
const MOD_OFFSET_Y = 0.213; // left/right (+y = robot left)
// ponytail: station wall Y = fractions of field height for the "1,2,3" numbering,
// blue-origin Y. 2026 REBUILT is 180° ROTATIONALLY symmetric, so Red's slots mirror
// Blue's (drawYouMarker flips the fraction for Red). Visualization only.
// TODO verify station-number <-> wall-position mapping at the field.
const STATION_Y_FRAC: Record<string, number> = { '1': 5 / 6, '2': 1 / 2, '3': 1 / 6 };

// ---- field panel state -------------------------------------------------------
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
// Guarded so this module is import-safe under Node (geometry self-check).
const fieldImg: HTMLImageElement = typeof Image !== 'undefined' ? new Image() : ({} as HTMLImageElement);
let imgReady = false;
let layout: Layout = { mode: 'full', s: 1, ox: 0, oy: 0, cssW: 0, cssH: 0 };
let driverPerspective = false; // field-panel orientation toggle, in-memory only
let dirty = true;
let lastDraw = 0;

// ---- orientation panel state (registry id still `laptop-map`) ----------------
let mapCanvas: HTMLCanvasElement | null = null;
let mapCtx: CanvasRenderingContext2D | null = null;
let mapCssW = 0;
let mapCssH = 0;
let mapHeadingEl: HTMLElement | null = null;
let mapDirty = true;
let mapLastDraw = 0;

// User calibration for when the gyro zero doesn't point away-from-driver (shop-floor
// practice, etc.). Renderer-only; persisted in localStorage (NOT in Settings — main.ts
// owns that type). Added to displayDeg so the ring can be re-zeroed toward FORWARD.
const OFFSET_KEY = 'helios.orientation.userOffsetDeg';
let userOffsetDeg = readUserOffset();
function readUserOffset(): number {
  if (typeof localStorage === 'undefined') return 0;
  const v = Number(localStorage.getItem(OFFSET_KEY));
  return Number.isFinite(v) ? norm360(v) : 0;
}
function persistUserOffset(): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(OFFSET_KEY, String(userOffsetDeg));
}
function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

// Radar zero: the pose treated as "where YOU are". Defaults to the odometry origin
// (the robot's power-on/zero point); the 📍 button re-marks it to the current pose.
// In-memory only — odometry origins don't survive robot reboots, so persisting this
// would silently lie next session.
let youPos = { x: 0, y: 0 };

// Alliance "forward" (operator perspective, same convention as the drive code): Blue
// pushes toward +x (heading 0), Red pushes toward -x (heading 180).
function allianceForwardDeg(): number {
  return pickedStation.startsWith('R') ? 180 : 0;
}
// The one rotation formula (single source; the debug getter exposes it verbatim so a
// test can check the alliance flip without having to change the live station).
function computeDisplayDeg(headingDeg: number, isRed: boolean, offset: number): number {
  return headingDeg - (isRed ? 180 : 0) + offset;
}
// Robot heading as shown on the compass: 0 => points UP (FORWARD, away from you).
function displayDeg(): number | null {
  if (!pose) return null;
  return computeDisplayDeg(pose.headingDeg, pickedStation.startsWith('R'), userOffsetDeg);
}

// Radar placement (pure, exported for the geometry self-check): driver-frame bearing
// (deg, 0 = FORWARD/up, + toward the driver's LEFT) + distance -> canvas offset from
// the ring center. Soft range scale keeps any distance inside R (3 m lands mid-ring).
export function radarOffset(brgDeg: number, distM: number, R: number): { dx: number; dy: number } {
  const r = R * (distM / (distM + 3));
  const a = (brgDeg * Math.PI) / 180;
  return { dx: -Math.sin(a) * r, dy: -Math.cos(a) * r };
}

function currentMode(): FieldMode {
  if (!driverPerspective) return 'full';
  return pickedStation.startsWith('B') ? 'driverBlue' : 'driverRed';
}

function markDirty(): void {
  dirty = true;
  mapDirty = true;
}

// ---- station picker + follow-the-DS lock (overlay in the field panel) --------
// The picker DOM lives inside the field panel (built fresh each mount), but its state
// and the follow-DS logic are module-level so they survive remounts and keep the store
// correct even while the panel is detached. app.ts no longer owns any of this.
const FOLLOW_LABEL = '\u{1F517} following Driver Station';
const STATIONS: { s: Station; cls: string }[] = [
  { s: 'R1', cls: 'stn-red' }, { s: 'R2', cls: 'stn-red' }, { s: 'R3', cls: 'stn-red' },
  { s: 'B1', cls: 'stn-blue' }, { s: 'B2', cls: 'stn-blue' }, { s: 'B3', cls: 'stn-blue' },
];
let pickerEl: HTMLElement | null = null;
let pickerButtons: HTMLButtonElement[] = [];
let pickerNote: HTMLElement | null = null;
let pickerLocked = false;
let pickerCaption = '';
let hintTimer: number | undefined;

// Follow-DS inputs (live NT /FMSInfo, trusted only while a DS is attached).
let followConnected = false;
let fmsIsRed: boolean | null = null;
let fmsStation: number | null = null;
let fmsDsAttached = false; // /FMSInfo/FMSControlData bit 0x20

// Push current module state onto whatever picker DOM is mounted (guards for detached).
function applyPicker(): void {
  for (const b of pickerButtons) b.classList.toggle('active', b.dataset.station === pickedStation);
  if (pickerEl) {
    pickerEl.classList.toggle('locked', pickerLocked);
    if (pickerLocked) pickerEl.title = 'Station follows the Driver Station — set it in the DS';
    else pickerEl.removeAttribute('title');
  }
  if (pickerNote) {
    pickerNote.hidden = !pickerLocked;
    if (pickerLocked) pickerNote.textContent = pickerCaption;
  }
}

// Follow the live NT /FMSInfo station — but only while FMSControlData says a DS is
// actually attached: an unattended roboRIO publishes the boot defaults (Red 1), which
// must never lock the picker. No trusted live source => manual picking (+ the DS-ini
// soft-sync below, which adopts the DS's saved station at the moments it's fresh).
function reconcileFollow(): void {
  const fmsOk =
    followConnected && fmsDsAttached && fmsIsRed !== null &&
    fmsStation !== null && fmsStation >= 1 && fmsStation <= 3;
  pickerLocked = fmsOk;
  pickerCaption = FOLLOW_LABEL;
  if (fmsOk) {
    const follow = `${fmsIsRed ? 'R' : 'B'}${fmsStation}` as Station;
    if (getSettings().station !== follow) {
      void updateSettings({ station: follow }); // -> onSettings -> pickedStation + applyPicker
    }
  }
  applyPicker();
}

// ---- DS station soft-sync (never locks; live /FMSInfo above still wins) -------
// The DS's live dropdown is NOT observable from outside while it runs — verified
// 2026-07-11: dropdown on B1 while the saved ini still said R1, and neither the 1741
// dashboard feed nor the 1742 JSON status carries the station. The ini is only truthful
// at two moments, and both get adopted (without locking the picker):
//   (a) the DS was just launched via our Launch DS button — it just READ the ini;
//   (b) the saved value CHANGED — the DS just WROTE it (on exit).
// A companion restart next to a long-running DS adopts nothing: the ini may be stale,
// and clobbering the user's picked station with a stale value was the original R1 bug.
let lastDsStation: Station | null = null;
let adoptOnFound = false;

// app.ts arms this when the user clicks Launch DS.
export function armDsStationAdopt(): void {
  adoptOnFound = true;
}

function adoptDsStation(st: Station): void {
  if (!pickerLocked && getSettings().station !== st) void updateSettings({ station: st });
}

function onDsStatus(s: { found: boolean; dsStation: Station | null }): void {
  const st = s.dsStation;
  if (st) {
    if (adoptOnFound && s.found) {
      adoptOnFound = false;
      adoptDsStation(st);
    } else if (lastDsStation !== null && st !== lastDsStation) {
      adoptDsStation(st);
    }
    lastDsStation = st; // null = ini unreadable; keep the last known value
  }
}

// Build the station-picker overlay inside a panel container (rebuilt fresh each mount).
function buildStationPicker(container: HTMLElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'field-station-overlay';

  const picker = document.createElement('div');
  picker.id = 'station-picker';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Driver station');

  pickerButtons = [];
  for (const { s, cls } of STATIONS) {
    const b = document.createElement('button');
    b.className = `stn ${cls}`;
    b.dataset.station = s;
    b.textContent = s;
    b.addEventListener('click', () => {
      if (pickerLocked) {
        // Read-only while following the DS: flash where to actually set it.
        if (pickerNote) {
          pickerNote.textContent = 'set it in the Driver Station';
          window.clearTimeout(hintTimer);
          hintTimer = window.setTimeout(() => {
            if (pickerLocked && pickerNote) pickerNote.textContent = pickerCaption;
          }, 1600);
        }
        return;
      }
      void updateSettings({ station: b.dataset.station as Station });
    });
    picker.appendChild(b);
    pickerButtons.push(b);
  }

  const note = document.createElement('span');
  note.className = 'stn-lock-note';
  note.hidden = true;

  overlay.appendChild(picker);
  overlay.appendChild(note);
  container.appendChild(overlay);
  pickerEl = picker;
  pickerNote = note;
}

// ---- shared subscriptions (run once for the whole module) --------------------
// Registry contract: NT subs / timers must live behind a one-shot guard, not in mount
// (reopening a panel calls mount again). Both panels share this single pose/module/
// station flow and a single rAF loop, so opening either panel — or both — works, and
// reopening never duplicates a subscription. Retained NT values replay on subscribe.
let subsReady = false;
function ensureFieldSubs(): void {
  if (subsReady) return;
  subsReady = true;

  pickedStation = getSettings().station;
  onSettings((s) => {
    if (s.station !== pickedStation) {
      pickedStation = s.station;
      resizeField(); // field driver-mode alliance may have flipped (no-op if unmounted)
      resizeMap(); // orientation alliance-forward may have flipped (no-op if unmounted)
    }
    applyPicker(); // active chip / lock state onto the mounted picker
    markDirty();
  });

  // Follow-DS: live NT /FMSInfo (robot connected — the live truth while a DS is attached).
  onConnection((c) => {
    followConnected = c.connected;
    // Drop stale FMS on disconnect so a reconnect waits for fresh values before locking.
    if (!followConnected) {
      fmsIsRed = null;
      fmsStation = null;
      fmsDsAttached = false;
    }
    reconcileFollow();
  });
  onValue(TOPICS.isRedAlliance, (v) => {
    fmsIsRed = Boolean(v);
    reconcileFollow();
  });
  onValue(TOPICS.stationNumber, (v) => {
    fmsStation = Number(v);
    reconcileFollow();
  });
  onValue(TOPICS.fmsControl, (v) => {
    fmsDsAttached = (Number(v) & 0x20) !== 0;
    reconcileFollow();
  });

  // DS-ini soft-sync feed (see onDsStatus). Pull once to seed, then track pushes.
  window.companion.ds.onStatus(onDsStatus);
  void window.companion.ds.status().then(onDsStatus);

  onValue(TOPICS.pose, (v) => {
    const a = v as number[];
    if (!Array.isArray(a) || a.length < 3) return;
    const prev = trail.length > 0 ? trail[trail.length - 1] : null;
    pose = { x: a[0], y: a[1], headingDeg: a[2] };
    // A >1 m jump in one packet is a teleport (auto pose seed / odometry re-zero),
    // not motion — clear the trail instead of streaking a line across the field.
    if (prev && Math.hypot(pose.x - prev.x, pose.y - prev.y) > 1) trail.length = 0;
    trail.push(pose);
    if (trail.length > TRAIL_MAX) trail.shift();
    markDirty();
  });
  onValue(TOPICS.moduleStates, (v) => {
    const u = toU8(v);
    if (u) {
      modules = decodeSwerveModuleStates(u);
      updateDesync();
      markDirty();
    }
  });
  onValue(TOPICS.moduleTargets, (v) => {
    const u = toU8(v);
    if (u) {
      moduleTargets = decodeSwerveModuleStates(u);
      updateDesync();
      markDirty();
    }
  });

  requestAnimationFrame(frame);
}

// Single redraw loop for both panels; each side draws only when dirty + mounted, ~30 fps.
// Each draw is isolated: a throw in one panel must not kill the shared loop (which would
// freeze the other panel too). rAF is paused by the browser when the window is occluded —
// that's intended; the panels repaint on their next dirty tick once visible again.
function frame(t: number): void {
  if (dirty && canvas && ctx && t - lastDraw >= 33) {
    dirty = false;
    lastDraw = t;
    try {
      draw();
    } catch (e) {
      console.error('[field] draw error', e);
    }
  }
  if (mapDirty && mapCanvas && mapCtx && t - mapLastDraw >= 33) {
    mapDirty = false;
    mapLastDraw = t;
    try {
      drawMap();
    } catch (e) {
      console.error('[laptop-map] draw error', e);
    }
  }
  requestAnimationFrame(frame);
}

function toU8(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

// ---- field panel -------------------------------------------------------------
// Build the field panel inside the given dockview container: a full-bleed canvas
// plus a floating orientation toggle. Re-invokable (reopen builds a fresh container).
export function mountField(container: HTMLElement): void {
  container.classList.add('field-body');
  container.textContent = '';

  canvas = document.createElement('canvas');
  canvas.id = 'field-canvas';
  container.appendChild(canvas);

  const toggle = document.createElement('button');
  toggle.className = 'pane-toggle field-toggle';
  toggle.title = 'Field orientation';
  toggle.textContent = driverPerspective ? 'FULL FIELD' : 'DRIVER VIEW';
  toggle.classList.toggle('active', driverPerspective);
  container.appendChild(toggle);

  // Station picker overlay (moved out of the top bar into the field, top-left edge).
  buildStationPicker(container);

  ctx = canvas.getContext('2d');

  fieldImg.onload = () => {
    imgReady = true;
    markDirty();
  };
  fieldImg.onerror = () => console.error('[field] failed to load assets/2026-field.png');
  fieldImg.src = 'assets/2026-field.png';

  ensureFieldSubs();
  pickedStation = getSettings().station;

  // Mode toggle (in-memory only).
  toggle.addEventListener('click', () => {
    driverPerspective = !driverPerspective;
    toggle.classList.toggle('active', driverPerspective);
    toggle.textContent = driverPerspective ? 'FULL FIELD' : 'DRIVER VIEW';
    console.log(`[field] mode=${currentMode()}`);
    resizeField();
  });

  // Module-level observer, replaced per mount — a per-mount `new ResizeObserver`
  // with no disconnect leaked one observer (pinning its detached container) per reopen.
  fieldRo?.disconnect();
  fieldRo = new ResizeObserver(() => resizeField());
  fieldRo.observe(canvas.parentElement ?? canvas);
  window.addEventListener('resize', resizeField);
  resizeField();
  applyPicker(); // sync the freshly-built picker to current lock/active state
}

let fieldRo: ResizeObserver | null = null;
let mapRo: ResizeObserver | null = null;

// Backing store = element size x devicePixelRatio; draw space stays in CSS px.
export function resizeField(): void {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layout = computeLayout(currentMode(), cssW, cssH);
  dirty = true;
}

// Preserved signature: meters -> canvas CSS px, using the current field-mode layout.
export function fieldToCanvas(xM: number, yM: number): { x: number; y: number } {
  return fieldToCanvasAt(layout, xM, yM);
}

function draw(): void {
  if (!ctx) return;
  const { cssW, cssH, s } = layout;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#0b1119';
  ctx.fillRect(0, 0, cssW, cssH);

  drawFieldImage();

  // Field outline (mapped corners so it rotates with the mode).
  const c0 = fieldToCanvasAt(layout, 0, 0);
  const c1 = fieldToCanvasAt(layout, FIELD_W_M, 0);
  const c2 = fieldToCanvasAt(layout, FIELD_W_M, FIELD_H_M);
  const c3 = fieldToCanvasAt(layout, 0, FIELD_H_M);
  ctx.strokeStyle = 'rgba(255,176,32,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(c0.x, c0.y);
  ctx.lineTo(c1.x, c1.y);
  ctx.lineTo(c2.x, c2.y);
  ctx.lineTo(c3.x, c3.y);
  ctx.closePath();
  ctx.stroke();

  drawYouMarker();
  drawTrail();
  drawArrows(s);
  drawDesyncBadge();

  if (pose) {
    drawRobot(pose.x, pose.y, (pose.headingDeg * Math.PI) / 180);
  } else {
    const mid = fieldToCanvasAt(layout, FIELD_W_M / 2, FIELD_H_M / 2);
    ctx.fillStyle = 'rgba(139,155,176,0.5)';
    ctx.font = '11px "Cascadia Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AWAITING POSE', mid.x, mid.y);
    ctx.textAlign = 'start';
  }
}

// One code path for all modes: map the image's source corners to canvas and draw
// through the resulting affine transform (rotation/reflection handled automatically).
function drawFieldImage(): void {
  if (!ctx || !imgReady) return;
  const origin = fieldToCanvasAt(layout, 0, FIELD_H_M); // image px (0,0)
  const right = fieldToCanvasAt(layout, FIELD_W_M, FIELD_H_M); // image px (sw,0)
  const down = fieldToCanvasAt(layout, 0, 0); // image px (0,sh)
  const ux = (right.x - origin.x) / CROP.sw;
  const uy = (right.y - origin.y) / CROP.sw;
  const vx = (down.x - origin.x) / CROP.sh;
  const vy = (down.y - origin.y) / CROP.sh;
  ctx.save();
  ctx.transform(ux, uy, vx, vy, origin.x, origin.y);
  ctx.drawImage(fieldImg, CROP.sx, CROP.sy, CROP.sw, CROP.sh, 0, 0, CROP.sw, CROP.sh);
  ctx.restore();
}

function drawTrail(): void {
  if (!ctx || trail.length < 2) return;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = fieldToCanvasAt(layout, trail[i - 1].x, trail[i - 1].y);
    const b = fieldToCanvasAt(layout, trail[i].x, trail[i].y);
    const alpha = (i / trail.length) * 0.55; // older = fainter
    ctx.strokeStyle = `rgba(255,176,32,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawRobot(xM: number, yM: number, headingRad: number): void {
  if (!ctx) return;
  const c = fieldToCanvasAt(layout, xM, yM);
  const ang = fieldDirToCanvasAngle(layout, xM, yM, headingRad);
  const px = 0.85 * layout.s;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(ang);
  // Body (symmetric, so the transform's reflection is invisible here).
  ctx.beginPath();
  ctx.roundRect(-px / 2, -px / 2, px, px, px * 0.16);
  ctx.fillStyle = 'rgba(255,176,32,0.9)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0b1119';
  ctx.stroke();
  // Bold heading wedge at the front (+x local).
  ctx.beginPath();
  ctx.moveTo(px * 0.18, -px * 0.3);
  ctx.lineTo(px * 0.62, 0);
  ctx.lineTo(px * 0.18, px * 0.3);
  ctx.closePath();
  ctx.fillStyle = '#1a1206';
  ctx.fill();
  ctx.restore();
}

// Per-module velocity arrows at the robot's corners. Positions + directions are
// computed in field meters (module angle is robot-relative) then mapped, so they
// stay pinned to the correct physical corners in every mode. Commanded targets
// (ModuleTargets) draw first as faint ghosts under the solid actual arrows — a
// visible gap between ghost and solid = the steer-desync signal, drawn live.
function drawArrows(s: number): void {
  if (!ctx || !pose) return;
  const th = (pose.headingDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const corners = [
    [MOD_OFFSET_X, MOD_OFFSET_Y], // FL
    [MOD_OFFSET_X, -MOD_OFFSET_Y], // FR
    [-MOD_OFFSET_X, MOD_OFFSET_Y], // BL
    [-MOD_OFFSET_X, -MOD_OFFSET_Y], // BR
  ];
  const drawSet = (mods: { speedMps: number; angleRad: number }[], color: string, width: number): void => {
    if (!ctx || mods.length < 4) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const m = mods[i];
      if (Math.abs(m.speedMps) < 0.05) continue;
      const [lx, ly] = corners[i];
      const bx = pose!.x + (lx * cos - ly * sin);
      const by = pose!.y + (lx * sin + ly * cos);
      const dir = th + m.angleRad + (m.speedMps < 0 ? Math.PI : 0);
      const lenM = Math.min(Math.abs(m.speedMps) * 0.14, 0.85);
      const tx = bx + Math.cos(dir) * lenM;
      const ty = by + Math.sin(dir) * lenM;
      const a = fieldToCanvasAt(layout, bx, by);
      const b = fieldToCanvasAt(layout, tx, ty);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // Arrowhead in canvas space.
      const head = Math.atan2(b.y - a.y, b.x - a.x);
      const hs = Math.max(5, 0.11 * s);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - hs * Math.cos(head - 0.5), b.y - hs * Math.sin(head - 0.5));
      ctx.lineTo(b.x - hs * Math.cos(head + 0.5), b.y - hs * Math.sin(head + 0.5));
      ctx.closePath();
      ctx.fill();
    }
  };
  drawSet(moduleTargets, 'rgba(255,255,255,0.35)', 1.5); // commanded (ghost)
  drawSet(modules, '#7ad7ff', 2.5); // actual
}

// Red banner over the field while any module's actual direction has diverged from
// its commanded direction for >DESYNC_HOLD_MS (see updateDesync).
function drawDesyncBadge(): void {
  if (!ctx) return;
  const bad = MODULE_LABELS.filter((_, i) => desyncActive[i]);
  if (bad.length === 0) return;
  const { cssW } = layout;
  ctx.font = '700 13px "Bahnschrift", sans-serif';
  ctx.textAlign = 'center';
  const text = `⚠ STEER DESYNC ${bad.join(' ')}`;
  const w = ctx.measureText(text).width + 20;
  ctx.fillStyle = 'rgba(255,65,85,0.92)';
  ctx.fillRect((cssW - w) / 2, 8, w, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, cssW / 2, 24);
  ctx.textAlign = 'start';
}

function drawYouMarker(): void {
  if (!ctx) return;
  const isRed = pickedStation.startsWith('R');
  const wallX = isRed ? FIELD_W_M : 0;
  // 2026 REBUILT is 180° rotationally symmetric, so Red's station order runs the
  // OPPOSITE way along its wall — mirror the fraction (same-fraction-both-walls put
  // R1 at R3's end and vice versa).
  const frac = STATION_Y_FRAC[pickedStation[1]];
  const yM = (isRed ? 1 - frac : frac) * FIELD_H_M;
  const into = isRed ? -0.9 : 0.9; // meters into the field from the wall
  const at = fieldToCanvasAt(layout, wallX, yM);
  const tip = fieldToCanvasAt(layout, wallX + into, yM);
  const color = isRed ? '#ff4155' : '#3d8bff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = '700 10px "Bahnschrift", sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText('YOU', at.x, at.y - 9);
  ctx.textAlign = 'start';
}

// ---- orientation radar (registry id `laptop-map`, retitled "Orientation") ----
// Off the field a field view is wrong, but the robot still has a pose relative to
// wherever its odometry was zeroed. This is a radar: YOU (your laptop) at the center of
// a FIXED cardinal ring (FORWARD / BACK / LEFT / RIGHT), with the robot as the one bold
// glyph orbiting by its relative bearing/distance — so a robot BEHIND you draws below
// center — and rotating live with its heading. FORWARD = away from you.
//
// Rotation math: displayDeg = poseHeadingDeg - allianceForwardDeg + userOffsetDeg, drawn
// so displayDeg 0 points UP (toward FORWARD). allianceForward is 0° (Blue) / 180° (Red),
// the operator-perspective convention from the drive code, so e.g. blue heading 0 -> up,
// red heading 0 -> down. userOffsetDeg is the manual re-zero knob for off-field practice.
// The position vector (pose - youPos) is rotated through the same formula, so heading
// and bearing stay in one frame; 📍 re-marks youPos when the robot sits beside you.
export function mountLaptopMap(container: HTMLElement): void {
  container.classList.add('orient-body');
  container.textContent = '';

  mapCanvas = document.createElement('canvas');
  mapCanvas.className = 'orient-canvas';
  container.appendChild(mapCanvas);

  // Live heading readout (crisp DOM text, top-left).
  const head = document.createElement('div');
  head.className = 'orient-heading';
  head.innerHTML =
    '<span class="orient-heading-num">--</span><span class="orient-heading-unit">° heading</span>';
  container.appendChild(head);
  mapHeadingEl = head.querySelector('.orient-heading-num');

  // Calibration controls (top-right): re-zero the ring when the gyro zero doesn't point
  // away from you. Each adjusts userOffsetDeg, persists it, and repaints.
  const ctrls = document.createElement('div');
  ctrls.className = 'orient-ctrls';
  const mk = (label: string, title: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.className = 'orient-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      fn();
      persistUserOffset();
      mapDirty = true;
    });
    ctrls.appendChild(b);
  };
  mk('↺90°', 'Rotate the view 90° left', () => {
    userOffsetDeg = norm360(userOffsetDeg - 90);
  });
  mk('↻90°', 'Rotate the view 90° right', () => {
    userOffsetDeg = norm360(userOffsetDeg + 90);
  });
  mk('flip', 'Flip the view 180°', () => {
    userOffsetDeg = norm360(userOffsetDeg + 180);
  });
  mk('reset', 'Clear the calibration offset', () => {
    userOffsetDeg = 0;
  });
  mk('\u{1F4CD}', 'Mark: the robot is right next to me (zeros the radar position)', () => {
    if (pose) youPos = { x: pose.x, y: pose.y };
  });
  container.appendChild(ctrls);

  // Caption stating the assumptions the whole view rests on.
  const cap = document.createElement('div');
  cap.className = 'orient-caption';
  cap.textContent =
    'Forward = away from you; center = you (assumed at the robot’s power-on point). ' +
    '\u{1F4CD} when the robot is beside you; ↺↻ re-zero FORWARD.';
  container.appendChild(cap);

  mapCtx = mapCanvas.getContext('2d');
  ensureFieldSubs();
  pickedStation = getSettings().station;

  // Debug getter for the CDP harness: verify the rotation math without reading pixels.
  // `compute` is the exact formula the draw uses, so a test can check the alliance-forward
  // flip (blue heading 0 -> 0 -> UP; red heading 0 -> -180 -> DOWN) without changing station.
  (window as Window & { __orient?: () => unknown }).__orient = () => ({
    headingDeg: pose ? pose.headingDeg : null,
    allianceForwardDeg: allianceForwardDeg(),
    userOffsetDeg,
    displayDeg: displayDeg(),
    youPos: { ...youPos },
    distM: pose ? Math.hypot(pose.x - youPos.x, pose.y - youPos.y) : null,
    compute: (h: number, isRed: boolean, off: number) => computeDisplayDeg(h, isRed, off),
  });

  // Same leak fix as mountField: one module-level observer, replaced per mount.
  mapRo?.disconnect();
  mapRo = new ResizeObserver(() => resizeMap());
  mapRo.observe(mapCanvas.parentElement ?? mapCanvas);
  window.addEventListener('resize', resizeMap);
  resizeMap();
}

// No field layout anymore — just size the backing store; draw space stays CSS px.
export function resizeMap(): void {
  if (!mapCanvas || !mapCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = mapCanvas.getBoundingClientRect();
  mapCssW = Math.max(1, Math.round(rect.width));
  mapCssH = Math.max(1, Math.round(rect.height));
  mapCanvas.width = Math.round(mapCssW * dpr);
  mapCanvas.height = Math.round(mapCssH * dpr);
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapDirty = true;
}

function drawMap(): void {
  if (!mapCtx) return;
  const ctx = mapCtx;
  const W = mapCssW;
  const H = mapCssH;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b1119';
  ctx.fillRect(0, 0, W, H);

  // Geometry: cardinal ring centered in the panel; laptop (YOU) fixed at ring center.
  const cx = W / 2;
  const cy = H / 2 + 8;
  const R = Math.max(26, Math.min(cx - 44, cy - 34, H - cy - 34));

  // Signature: a faint forward axis from YOU up through the ring to FORWARD — the one line
  // that makes "forward = away from you" visible.
  ctx.strokeStyle = 'rgba(255,176,32,0.16)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 14);
  ctx.lineTo(cx, cy - R - 6);
  ctx.stroke();

  // Cardinal ring (hairline cyan — deliberately NOT a field boundary).
  ctx.strokeStyle = 'rgba(122,215,255,0.28)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // Ticks every 45°; the four cardinals longer + brighter.
  for (let a = 0; a < 360; a += 45) {
    const rad = (a - 90) * (Math.PI / 180); // 0° at top
    const card = a % 90 === 0;
    const inner = card ? R - 9 : R - 5;
    ctx.strokeStyle = card ? 'rgba(122,215,255,0.55)' : 'rgba(122,215,255,0.22)';
    ctx.lineWidth = card ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rad) * inner, cy + Math.sin(rad) * inner);
    ctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R);
    ctx.stroke();
  }

  // Cardinal labels (Bahnschrift condensed, quiet).
  ctx.font = '700 12px "Bahnschrift", sans-serif';
  ctx.fillStyle = '#8b9bb0';
  ctx.textAlign = 'center';
  ctx.fillText('FORWARD', cx, cy - R - 10);
  ctx.fillText('BACK', cx, cy + R + 20);
  ctx.textAlign = 'right';
  ctx.fillText('LEFT', cx - R - 8, cy + 4);
  ctx.textAlign = 'left';
  ctx.fillText('RIGHT', cx + R + 8, cy + 4);
  ctx.textAlign = 'start';

  drawOrientLaptop(ctx, cx, cy); // under the robot glyph, so an at-your-feet robot covers it

  // Robot glyph (the one bold element), placed by its bearing/distance from YOU and
  // rotated by its heading — or a placeholder if no pose yet.
  const dd = displayDeg();
  if (dd === null) {
    ctx.fillStyle = 'rgba(139,155,176,0.6)';
    ctx.font = '11px "Cascadia Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AWAITING HEADING', cx, cy - R - 26);
    ctx.textAlign = 'start';
  } else {
    // Position vector rotated through the same driver-frame formula as the heading.
    const relX = pose!.x - youPos.x;
    const relY = pose!.y - youPos.y;
    const distM = Math.hypot(relX, relY);
    const brg = computeDisplayDeg(
      (Math.atan2(relY, relX) * 180) / Math.PI,
      pickedStation.startsWith('R'),
      userOffsetDeg,
    );
    const { dx, dy } = radarOffset(brg, distM, R);
    drawOrientRobot(ctx, cx + dx, cy + dy, dd, R, distM);
  }

  if (mapHeadingEl) mapHeadingEl.textContent = pose ? String(Math.round(norm360(pose.headingDeg))) : '--';
}

// Robot glyph drawn with its FRONT toward -y (up) at rotation 0, then rotated by
// -displayDeg so displayDeg 0 => front UP (FORWARD) and increasing displayDeg turns the
// front toward the driver's LEFT (matches +heading = CCW in the field for a Blue driver).
// (cx, cy) is the radar position within the ring; distM is labeled under the glyph.
function drawOrientRobot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  displayDegVal: number,
  R: number,
  distM: number,
): void {
  const px = Math.max(20, R * 0.38);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-(displayDegVal * Math.PI) / 180);
  // Body.
  ctx.beginPath();
  ctx.roundRect(-px / 2, -px / 2, px, px, px * 0.16);
  ctx.fillStyle = 'rgba(255,176,32,0.95)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#0b1119';
  ctx.stroke();
  // Bold FRONT wedge, pointing up (-y local), overhanging the body so it clearly points.
  ctx.beginPath();
  ctx.moveTo(-px * 0.42, -px * 0.08);
  ctx.lineTo(0, -px * 0.92);
  ctx.lineTo(px * 0.42, -px * 0.08);
  ctx.closePath();
  ctx.fillStyle = '#1a1206';
  ctx.fill();
  ctx.restore();
  if (distM >= 0.05) {
    ctx.font = '10px "Cascadia Mono", monospace';
    ctx.fillStyle = '#8b9bb0';
    ctx.textAlign = 'center';
    ctx.fillText(`${distM.toFixed(1)} m`, cx, cy + px * 0.85 + 11);
    ctx.textAlign = 'start';
  }
}

// Laptop glyph = YOU, alliance-colored, fixed at the ring center, with a "YOU · <stn>"
// label just beneath it.
function drawOrientLaptop(ctx: CanvasRenderingContext2D, cx: number, y: number): void {
  const isRed = pickedStation.startsWith('R');
  const col = isRed ? '#ff4155' : '#3d8bff';
  const w = 24;
  const h = 14;
  ctx.save();
  ctx.translate(cx, y + 8); // body spans -20..+4 local; +8 optically centers it on the ring
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#0b1119';
  // Screen (leaning up toward the ring).
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h - 6, w, h, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(234,240,248,0.22)';
  ctx.fillRect(-w / 2 + 3, -h - 3, w - 6, h - 6);
  // Keyboard base (trapezoid).
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-w / 2 - 3, -3);
  ctx.lineTo(w / 2 + 3, -3);
  ctx.lineTo(w / 2 + 8, 4);
  ctx.lineTo(-w / 2 - 8, 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.font = '700 10px "Bahnschrift", sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(`YOU · ${pickedStation}`, cx, y + 24);
  ctx.textAlign = 'start';
}

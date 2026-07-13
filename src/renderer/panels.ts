// Panels (M5): four independent dockview panels (were one diagnostics column) —
//   power        per-motor stator-current bars + temp badges, grouped, with a
//                latched BROWNOUT RISK light.
//   vision-link  Limelight liveness/latency/target/tags + robot NT link.
//   mechanisms   shooter / intake / hopper state read from Shuffleboard.
//   auto-chooser PathPlanner auto dropdown with confirm (✓) / pending state.
// Each mountX(container) builds its DOM into the given panel element; the NT
// subscriptions are wired once per concern (ensure*Subs) so reopening a panel from
// the + menu rebuilds the DOM without duplicating subscriptions. The last retained-
// once values (motor names, chooser options, link state) are cached and re-applied
// on rebuild since NT won't replay them to a fresh panel.
// Every value shows a neutral "—" until its topic arrives. DOM writes only on change.
import { onValue, onConnection, ntPublish, TOPICS, type ConnState } from './nt';
import { focusMotor } from './graphs';

// /names order is fixed by spec (17 slots). Group + display-only bar scale (amps)
// per index — scales match each motor's configured current limit so a pinned motor
// fills its bar (they are display geometry, NOT the limits themselves):
//   drive 120, steer 40, shooter 40 (Kraken), Hood 20 (NEO 550),
//   IntakeRoller 40 (Kraken X44), IntakeSlider 60 (SparkMax NEO 2.0),
//   Hopper 20 (SparkMax NEO 2.0 — HopperSubsystem smartCurrentLimit(20)).
const SCALE: number[] = [
  120, 40, 120, 40, 120, 40, 120, 40, // drive/steer FL..BR
  40, 40, 40, 40, // shooter A-D
  20, // hood
  40, 60, // intake roller (Kraken), slider (Spark)
  20, 20, // hopper A, B (Spark)
];
// Fallback labels until /names arrives; also fixes display grouping.
const SPEC_NAMES = [
  'DriveFL', 'SteerFL', 'DriveFR', 'SteerFR', 'DriveBL', 'SteerBL', 'DriveBR', 'SteerBR',
  'ShooterA', 'ShooterB', 'ShooterC', 'ShooterD', 'Hood', 'IntakeRoller', 'IntakeSlider',
  'HopperA', 'HopperB',
];
const GROUPS: { name: string; idx: number[] }[] = [
  { name: 'Drive', idx: [0, 2, 4, 6] },
  { name: 'Steer', idx: [1, 3, 5, 7] },
  { name: 'Shooter', idx: [8, 9, 10, 11] },
  { name: 'Hood', idx: [12] },
  { name: 'Intake', idx: [13, 14] },
  { name: 'Hopper', idx: [15, 16] },
];

const T = TOPICS.telemetry;
const LL = TOPICS.limelight;
const CH = TOPICS.autoChooser;
const SHOOTER = '/Shuffleboard/Shooter Subsystem Tab';
const INTAKE = '/Shuffleboard/Intake Subsystem Tab';
const HOPPER = '/Shuffleboard/Hopper Subsystem Tab';

// Per-index temp thresholds [warn, bad] °C — one 70/90 cutoff fit only the TalonFX
// rows; the NEO 550 hood is fragile and the NEO 2.0 sparks sit in between.
// TODO tune against real on-robot temps once the mechanisms run under load.
const TEMP_DEFAULT: [number, number] = [70, 90]; // Kraken X60/X44 (TalonFX)
const TEMP_LIMITS: Record<number, [number, number]> = {
  12: [55, 70], // Hood — NEO 550
  14: [65, 85], // IntakeSlider — NEO 2.0
  15: [65, 85], // HopperA — NEO 2.0
  16: [65, 85], // HopperB — NEO 2.0
};

// ---- pure classifiers (self-checked) --------------------------------------
export function tempLevel(t: number, idx?: number): 'ok' | 'warn' | 'bad' {
  if (!Number.isFinite(t)) return 'ok';
  const [warn, bad] = (idx != null && TEMP_LIMITS[idx]) || TEMP_DEFAULT;
  if (t >= bad) return 'bad';
  if (t >= warn) return 'warn';
  return 'ok';
}
export function barPct(amps: number, scale: number): number {
  if (!Number.isFinite(amps) || scale <= 0) return 0;
  return Math.max(0, Math.min(100, (amps / scale) * 100));
}
export function barWarn(amps: number, scale: number): boolean {
  return Number.isFinite(amps) && amps >= 0.85 * scale; // >= 85% of display scale
}
export function voltageLevel(v: number): 'crit' | 'low' | 'ok' {
  if (v < 6.8) return 'crit'; // roboRIO brownout territory
  if (v < 7.5) return 'low'; // at-risk
  return 'ok';
}

// ---- small DOM helpers ----------------------------------------------------
function h(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}
function setLevel(el: HTMLElement | null, level: string): void {
  if (el && el.dataset.level !== level) el.dataset.level = level;
}

// ---- per-row power bar refs ----------------------------------------------
const rowEl: HTMLElement[] = [];
const nameEl: HTMLElement[] = [];
const fillEl: HTMLElement[] = [];
const ampsEl: HTMLElement[] = [];
const tempEl: HTMLElement[] = [];
let selectedIdx: number | null = null;

let brownoutEl: HTMLElement | null = null;
let latestVoltage: number | null = null;
let latestVoltageAtMs = 0; // performance.now() of the last voltage packet (staleness gate)
let powerNtConnected = false;
let brownoutLatchUntil = 0; // performance.now() ms; red held until here after a dip

// ===================== POWER BARS =====================
export function mountPowerBars(host: HTMLElement): void {
  buildPowerBars(host);
  ensurePowerSubs();
  if (lastNames) applyNames(lastNames); // re-apply real names to the fresh rows
}

let powerSubscribed = false;
function ensurePowerSubs(): void {
  if (powerSubscribed) return;
  powerSubscribed = true;
  onValue(T + '/names', (v) => {
    if (Array.isArray(v)) applyNames(v as string[]);
  });
  onValue(T + '/stator', (v) => {
    if (Array.isArray(v)) applyStator(v as number[]);
  });
  onValue(T + '/temp', (v) => {
    if (Array.isArray(v)) applyTemp(v as number[]);
  });
  onValue(T + '/voltage', (v) => {
    if (typeof v === 'number') {
      latestVoltage = v;
      latestVoltageAtMs = performance.now();
      if (v < 7.5) brownoutLatchUntil = performance.now() + 5000; // latch 5 s on any dip
    }
  });
  onConnection((c) => {
    powerNtConnected = c.connected;
    renderBrownout();
  });
  // Re-render the brownout light off a timer so the 5 s latch clears on time even
  // between voltage packets.
  setInterval(renderBrownout, 200);
}

function buildPowerBars(host: HTMLElement): void {
  host.textContent = '';
  host.classList.add('pb', 'dc-scroll');

  brownoutEl = h('div', 'brownout');
  brownoutEl.dataset.level = 'ok';
  brownoutEl.appendChild(h('span', 'bo-pip'));
  brownoutEl.appendChild(h('span', 'bo-label', 'BROWNOUT RISK'));
  host.appendChild(brownoutEl);

  for (const g of GROUPS) {
    host.appendChild(h('div', 'pb-group', g.name));
    for (const i of g.idx) {
      const row = h('div', 'pb-row');
      row.dataset.idx = String(i);
      const name = h('span', 'pb-name', SPEC_NAMES[i]);
      const bar = h('div', 'pb-bar');
      const fill = h('div', 'pb-fill');
      fill.dataset.level = 'ok';
      bar.appendChild(fill);
      const amps = h('span', 'pb-amps', '—');
      const temp = h('span', 'pb-temp', '—');
      temp.dataset.level = 'ok';
      row.append(name, bar, amps, temp);
      row.classList.toggle('sel', i === selectedIdx); // survive a panel rebuild
      row.addEventListener('click', () => toggleFocus(i));
      host.appendChild(row);
      rowEl[i] = row;
      nameEl[i] = name;
      fillEl[i] = fill;
      ampsEl[i] = amps;
      tempEl[i] = temp;
    }
  }
}

function toggleFocus(i: number): void {
  selectedIdx = selectedIdx === i ? null : i;
  for (let k = 0; k < rowEl.length; k++) {
    if (rowEl[k]) rowEl[k].classList.toggle('sel', k === selectedIdx);
  }
  focusMotor(selectedIdx);
}

let lastNames: string[] | null = null;
function applyNames(names: string[]): void {
  lastNames = names;
  for (let i = 0; i < names.length && i < nameEl.length; i++) {
    if (names[i]) setText(nameEl[i], names[i]);
  }
}

function applyStator(stator: number[]): void {
  for (let i = 0; i < stator.length && i < fillEl.length; i++) {
    const a = stator[i];
    const scale = SCALE[i] ?? 40;
    setText(ampsEl[i], Number.isFinite(a) ? `${a.toFixed(a < 10 ? 1 : 0)}A` : '—');
    fillEl[i].style.width = `${barPct(a, scale)}%`;
    setLevel(fillEl[i], barWarn(a, scale) ? 'warn' : 'ok');
  }
}

function applyTemp(temp: number[]): void {
  for (let i = 0; i < temp.length && i < tempEl.length; i++) {
    const t = temp[i];
    setText(tempEl[i], Number.isFinite(t) ? `${Math.round(t)}°` : '—');
    setLevel(tempEl[i], tempLevel(t, i));
  }
}

function renderBrownout(): void {
  if (!brownoutEl) return;
  // Stale data must never read as "ok": with NT down or no voltage packet for 3 s
  // (robot rebooting, radio drop) the light goes gray-STALE instead of green.
  if (!powerNtConnected || performance.now() - latestVoltageAtMs > 3000) {
    setLevel(brownoutEl, 'stale');
    return;
  }
  let level: 'crit' | 'low' | 'ok' = 'ok';
  if (latestVoltage != null && latestVoltage < 6.8) level = 'crit';
  else if (performance.now() < brownoutLatchUntil) level = 'low';
  setLevel(brownoutEl, level);
}

// ===================== VISION HEALTH =====================
let vLlPip: HTMLElement | null = null;
let vFps: HTMLElement | null = null;
let vLatency: HTMLElement | null = null;
let vTarget: HTMLElement | null = null;
let vTags: HTMLElement | null = null;
let vLinkPip: HTMLElement | null = null;
let vRtt: HTMLElement | null = null;

let hb: number | null = null;
let hbPrevSec: number | null = null;
let tl: number | null = null;
let cl: number | null = null;

export function mountVision(host: HTMLElement): void {
  buildVision(host);
  ensureVisionSubs();
  renderLink(lastConn); // re-apply cached link state to the fresh DOM
}

function buildVision(host: HTMLElement): void {
  host.textContent = '';
  host.classList.add('kv-grid', 'dc-scroll');

  const ll = kv(host, 'Limelight');
  vLlPip = h('span', 'pip');
  vFps = h('span', 'kv-num', '—');
  ll.append(vLlPip, vFps);
  ll.appendChild(document.createTextNode(' fps'));

  vLatency = kvNum(host, 'Latency', 'ms');
  vTarget = kv(host, 'Target');
  vTags = kv(host, 'Tags');

  const link = kv(host, 'Robot Link');
  vLinkPip = h('span', 'pip');
  vRtt = h('span', 'kv-num', '—');
  link.append(vLinkPip, vRtt);
  link.appendChild(document.createTextNode(' ms'));
}

let visionSubscribed = false;
function ensureVisionSubs(): void {
  if (visionSubscribed) return;
  visionSubscribed = true;

  onValue(LL + '/hb', (v) => {
    if (typeof v === 'number') hb = v;
  });
  onValue(LL + '/tl', (v) => {
    if (typeof v === 'number') tl = v;
  });
  onValue(LL + '/cl', (v) => {
    if (typeof v === 'number') cl = v;
  });
  onValue(LL + '/tv', (v) => {
    if (typeof v === 'number') {
      setText(vTarget, v === 1 ? 'VISIBLE' : 'none');
      setLevel(vTarget, v === 1 ? 'ok' : 'dim');
    }
  });
  onValue(LL + '/botpose', (v) => {
    // MegaTag botpose: index 7 = tag count (guard array length).
    if (Array.isArray(v) && v.length > 7) setText(vTags, String(v[7] ?? 0));
  });

  // hb is a monotonic frame counter; delta over 1 s ~ Limelight FPS. alive = fps>0.
  setInterval(() => {
    if (hb == null) {
      // No heartbeat EVER received: after 5 s of live NT that's a dead/missing
      // Limelight — alarm, instead of sitting on the neutral boot pip forever.
      if (ntUpSinceMs && Date.now() - ntUpSinceMs > 5000) setLevel(vLlPip, 'bad');
      return;
    }
    const prev = hbPrevSec;
    hbPrevSec = hb;
    // Skip the level/fps write on the very first sample — one tick of history is
    // needed for a real delta; forcing fps=0 here flashed the pip red at boot.
    if (prev != null) {
      const fps = Math.max(0, hb - prev);
      if (vFps) setText(vFps, String(Math.round(fps)));
      setLevel(vLlPip, fps > 0 ? 'ok' : 'bad');
    }
    if (tl != null && cl != null) setText(vLatency, (tl + cl).toFixed(0));
  }, 1000);

  onConnection(renderLink);
}

let lastConn: ConnState = { connected: false, rttMs: null };
let ntUpSinceMs = 0; // Date.now() of the last down->up NT transition; 0 while down
function renderLink(c: ConnState): void {
  if (c.connected && !lastConn.connected) ntUpSinceMs = Date.now();
  else if (!c.connected) ntUpSinceMs = 0;
  lastConn = c;
  setLevel(vLinkPip, c.connected ? 'ok' : 'bad');
  setText(vRtt, c.connected && c.rttMs != null ? String(Math.round(c.rttMs)) : '—');
}

// ===================== MECHANISMS =====================
let mShotVel: HTMLElement | null = null;
let mShotTgt: HTMLElement | null = null;
let mShotAt: HTMLElement | null = null;
let mShotState: HTMLElement | null = null;
let mIntCur: HTMLElement | null = null;
let mIntDes: HTMLElement | null = null;
let mIntSlider: HTMLElement | null = null;
let mIntPeak: HTMLElement | null = null;
let mHopState: HTMLElement | null = null;
let mHopFuel: HTMLElement | null = null;

export function mountMechanisms(host: HTMLElement): void {
  buildMechanisms(host);
  ensureMechSubs();
}

function buildMechanisms(host: HTMLElement): void {
  host.textContent = '';
  host.classList.add('mech', 'dc-scroll');

  host.appendChild(h('div', 'mech-head', 'Shooter'));
  const shg = h('div', 'kv-grid');
  host.appendChild(shg);
  mShotVel = kv(shg, 'Velocity');
  mShotTgt = kv(shg, 'Target');
  mShotAt = kv(shg, 'At Speed');
  mShotState = kv(shg, 'State');

  host.appendChild(h('div', 'mech-head', 'Intake'));
  const ing = h('div', 'kv-grid');
  host.appendChild(ing);
  mIntCur = kv(ing, 'State');
  mIntDes = kv(ing, 'Desired');
  mIntSlider = kv(ing, 'Slider A');
  mIntPeak = kv(ing, 'Peak A');

  host.appendChild(h('div', 'mech-head', 'Hopper'));
  const hpg = h('div', 'kv-grid');
  host.appendChild(hpg);
  mHopState = kv(hpg, 'Index');
  const fuelRow = kvRow(hpg, 'Fuel');
  mHopFuel = h('span', 'kv-v', '—');
  fuelRow.appendChild(mHopFuel);
  fuelRow.appendChild(h('span', 'kv-tag', '(sensor stubbed)'));
}

let mechSubscribed = false;
function ensureMechSubs(): void {
  if (mechSubscribed) return;
  mechSubscribed = true;

  // Shooter
  onValue(SHOOTER + '/Current Velocity', (v) => {
    if (typeof v === 'number') setText(mShotVel, v.toFixed(0));
  });
  onValue(SHOOTER + '/Desired Velocity', (v) => {
    if (typeof v === 'number') setText(mShotTgt, v.toFixed(0));
  });
  onValue(SHOOTER + '/Desired Velocity Reached', (v) => {
    if (typeof v === 'boolean') {
      setText(mShotAt, v ? 'YES' : 'no');
      setLevel(mShotAt, v ? 'ok' : 'dim');
    }
  });
  onValue(SHOOTER + '/Subsystem State', (v) => {
    // Published as a BOOLEAN by ShooterSubsystem (enableSubsystem flag), not a string.
    if (typeof v === 'boolean') {
      setText(mShotState, v ? 'ENABLED' : 'DISABLED');
      setLevel(mShotState, v ? 'ok' : 'warn');
    }
  });
  // Intake
  onValue(INTAKE + '/Current Intake State', (v) => {
    if (typeof v === 'string') setText(mIntCur, v);
  });
  onValue(INTAKE + '/Desired Intake State', (v) => {
    if (typeof v === 'string') setText(mIntDes, v);
  });
  onValue(INTAKE + '/Slider Current (A)', (v) => {
    if (typeof v === 'number') setText(mIntSlider, v.toFixed(1));
  });
  onValue(INTAKE + '/Slider Peak Current This Move (A)', (v) => {
    if (typeof v === 'number') setText(mIntPeak, v.toFixed(1));
  });
  // Hopper
  onValue(HOPPER + '/Current Index State', (v) => {
    if (typeof v === 'string') setText(mHopState, v);
  });
  onValue(HOPPER + '/Fuel Detected Indexer', (v) => {
    // Hardware stub — always reads true; tagged so drivers don't trust it.
    if (typeof v === 'boolean') setText(mHopFuel, v ? 'DETECTED' : 'none');
  });
}

// ===================== AUTO CHOOSER =====================
let chooserSel: HTMLSelectElement | null = null;
let chooserStatus: HTMLElement | null = null;
let chooserActive: string | null = null;
let chooserOptsKey = '';
let chooserWanted: string | null = null; // preferred selection from robot (selected/default)
let lastOptions: string[] | null = null; // cached to re-populate a reopened panel
let robotEnabled = false; // FMSControlData bit 0x01 — lock the select while enabled

export function mountAutoChooser(host: HTMLElement): void {
  buildChooser(host);
  ensureChooserSubs();
  if (lastOptions) applyOptions(lastOptions); // repopulate the fresh (empty) select
}

function buildChooser(host: HTMLElement): void {
  host.textContent = '';
  host.classList.add('chooser', 'dc-scroll');

  const sel = document.createElement('select');
  sel.className = 'chooser-select';
  sel.appendChild(new Option('— no options —', ''));
  sel.addEventListener('change', () => {
    ntPublish(CH + '/selected', 'string', sel.value);
    renderChooserStatus();
  });
  chooserSel = sel;
  chooserOptsKey = ''; // fresh empty select — let applyOptions repopulate it

  chooserStatus = h('span', 'chooser-status', '—');
  chooserStatus.dataset.level = 'dim';

  host.append(sel, chooserStatus);
  applyChooserLock(); // fresh DOM — re-apply the cached enabled-interlock state
}

// Changing the auto selection mid-match does nothing (the robot reads it once at
// auto-init) but inviting the pick while enabled only causes confusion — lock it.
function applyChooserLock(): void {
  if (!chooserSel) return;
  chooserSel.disabled = robotEnabled;
  chooserSel.title = robotEnabled ? 'Locked while the robot is enabled' : '';
}

let chooserSubscribed = false;
function ensureChooserSubs(): void {
  if (chooserSubscribed) return;
  chooserSubscribed = true;

  onValue(CH + '/options', (v) => {
    if (Array.isArray(v)) applyOptions(v as string[]);
  });
  onValue(CH + '/selected', (v) => {
    if (typeof v === 'string') {
      chooserWanted = v;
      applyWanted();
    }
  });
  onValue(CH + '/default', (v) => {
    if (typeof v === 'string' && chooserWanted == null) {
      chooserWanted = v;
      applyWanted();
    }
  });
  onValue(CH + '/active', (v) => {
    if (typeof v === 'string') {
      chooserActive = v;
      renderChooserStatus();
    }
  });
  onValue(TOPICS.fmsControl, (v) => {
    robotEnabled = (Number(v) & 0x01) !== 0;
    applyChooserLock();
  });
}

function applyOptions(opts: string[]): void {
  lastOptions = opts;
  const key = opts.join('');
  if (key === chooserOptsKey || !chooserSel) return; // rebuild only on change
  chooserOptsKey = key;
  const keep = chooserSel.value;
  chooserSel.textContent = '';
  for (const o of opts) chooserSel.appendChild(new Option(o, o));
  // Preserve the user's pick if still valid, else the robot's wanted value.
  if (opts.includes(keep)) chooserSel.value = keep;
  else if (chooserWanted != null && opts.includes(chooserWanted)) chooserSel.value = chooserWanted;
  renderChooserStatus();
}

function applyWanted(): void {
  if (!chooserSel || chooserWanted == null) return;
  // Only adopt the robot's value if the user hasn't diverged from it yet.
  const opts = Array.from(chooserSel.options).map((o) => o.value);
  if (opts.includes(chooserWanted) && chooserSel.value === '') chooserSel.value = chooserWanted;
  renderChooserStatus();
}

function renderChooserStatus(): void {
  if (!chooserSel || !chooserStatus) return;
  const chosen = chooserSel.value;
  if (chosen && chooserActive === chosen) {
    setText(chooserStatus, '✓ confirmed');
    setLevel(chooserStatus, 'ok');
  } else if (chosen) {
    setText(chooserStatus, 'pending');
    setLevel(chooserStatus, 'warn');
  } else {
    setText(chooserStatus, '—');
    setLevel(chooserStatus, 'dim');
  }
}

// ===================== CONTROLS REFERENCE =====================
// Static driver reference of the Xbox bindings in RobotContainer.configureBindings().
// KEEP IN SYNC with RobotContainer.java — bindings are not published over NT, so this
// mirrors the code by hand (last synced 2026-07-12: slider + hopper + shooter disabled).
type CtlRow = { btn: string; desc: string; off?: string };
const CONTROLS: { group: string; rows: CtlRow[] }[] = [
  {
    group: 'Driving',
    rows: [
      { btn: 'L STICK', desc: 'Drive, field-centric (squared response, slew-limited)' },
      { btn: 'R STICK ↔', desc: 'Rotate (CCW positive)' },
      { btn: 'LB', desc: 'X-lock wheels — toggle: press to lock, press to release' },
      { btn: 'MENU', desc: 'Re-zero field heading (point robot downfield, press once)' },
      { btn: 'A / DPAD ↑', desc: 'Hold: auto-rotate to face the hub tag (vision)' },
    ],
  },
  {
    group: 'Intake — rollers only (slider disabled 2026-07-12)',
    rows: [
      { btn: 'LT', desc: 'Intake: rollers in — runs until X' },
      { btn: 'Y', desc: 'Outtake: rollers out — runs until X' },
      { btn: 'X', desc: 'Stop rollers (stow)' },
    ],
  },
  {
    group: 'Disabled bindings',
    rows: [
      { btn: 'B', desc: 'Hopper run', off: 'hopper disabled' },
      { btn: 'VIEW', desc: 'Hopper unjam', off: 'hopper disabled' },
      { btn: 'RB', desc: 'Manual shot — max hood + high speed', off: 'shooter disabled' },
      { btn: 'RT', desc: 'Auto shot — ballistics model', off: 'shooter disabled' },
      { btn: 'DPAD ←↓→', desc: 'Drive to feed positions', off: 'not wired — needs field poses' },
    ],
  },
];

// Static DOM only — no NT subs, no timers; trivially safe to re-mount.
export function mountControls(host: HTMLElement): void {
  host.textContent = '';
  host.classList.add('ctl', 'dc-scroll');
  for (const g of CONTROLS) {
    host.appendChild(h('div', 'mech-head', g.group));
    for (const r of g.rows) {
      const row = h('div', 'ctl-row');
      if (r.off) row.classList.add('ctl-off');
      row.appendChild(h('span', 'ctl-btn', r.btn));
      row.appendChild(h('span', 'ctl-desc', r.desc));
      if (r.off) row.appendChild(h('span', 'ctl-tag', r.off));
      host.appendChild(row);
    }
  }
}

// ---- key/value row builders -----------------------------------------------
function kvRow(parent: HTMLElement, label: string): HTMLElement {
  const row = h('div', 'kv');
  row.appendChild(h('span', 'kv-k', label));
  parent.appendChild(row);
  return row;
}
function kv(parent: HTMLElement, label: string): HTMLElement {
  const row = kvRow(parent, label);
  const v = h('span', 'kv-v', '—');
  v.dataset.level = 'dim';
  row.appendChild(v);
  return v;
}
function kvNum(parent: HTMLElement, label: string, unit: string): HTMLElement {
  const row = kvRow(parent, label);
  const v = h('span', 'kv-num', '—');
  row.appendChild(v);
  row.appendChild(document.createTextNode(` ${unit}`));
  return v;
}

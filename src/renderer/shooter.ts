// Shooter diagnostic panel for the V2 launcher (2026-09-30): flywheel speed in the same
// FLYWHEEL RPM the DPAD sets, the feeder, the belt gate RT waits on, and the hood (degrees
// above the bottom stop it homes into on every enable).
//
// The hood card also derives what Shuffleboard can't show:
//   LAST MOVE   how far the hood travelled during the last continuous motion (deg).
//   DRIFT       how far it has crept since that motion ended (deg) -- growing while parked
//               means it is sagging.
//   RATE        deg/s right now -- separates "parked" from "creeping".
//
// Read-only: this panel subscribes and never publishes. Everything comes off topics
// LauncherSubsystem writes every loop.
import { onValue, onConnection } from './nt';

// FULL topic paths, not a discovered prefix -- Shuffleboard entry names contain spaces and
// parentheses, and NT4 topic discovery on this stack does not enumerate them reliably.
const TAB = '/Shuffleboard/Shooter Subsystem Tab/';
const T_ANGLE = TAB + 'Current Angle';                 // deg above the homed bottom stop
const T_ANGLE_TARGET = TAB + 'Desired Angle';
const T_ANGLE_REACHED = TAB + 'Desired Angle Reached';
const T_HOOD_VOLTS = TAB + 'Hood Volts (cmd)';
const T_HOOD_AMPS = TAB + 'Hood Current (A)';
const T_RAW = TAB + 'Hood Encoder Raw (rot)';          // X44 rotor rotations
const T_HOOD_STATE = TAB + 'Hood State';               // WAITING_FOR_ENABLE/HOMING/HOMED/HOMING_FAILED/STALL_FAULT
const T_HOMING_TRAVEL = TAB + 'Hood Homing Travel (deg)';
const T_FLY = TAB + 'Current Velocity';                // FLYWHEEL rpm (what the DPAD sets)
const T_FLY_TARGET = TAB + 'Desired Velocity';         // FLYWHEEL rpm target
const T_FLY_AT = TAB + 'Desired Velocity Reached';
const T_MOTOR_RPM = TAB + 'Current Flywheel (motor RPM)';
const T_MOTOR_TARGET = TAB + 'RT Target (motor RPM)';
const T_FEEDER = TAB + 'Feeder (motor RPM)';
const T_FEEDER_AT = TAB + 'Feeder At Speed';
const T_READY = TAB + 'Ready To Feed (belts on)';
const T_SHOOTING = TAB + 'Subsystem State';            // true while RT is held

// Motion threshold: 3 deg/s is well above encoder jitter and well below a powered move
// (Motion Magic cruises at ~90 deg/s).
const MOVING_DEG_PER_SEC = 3;
// A stroke is only OVER once the hood has been quiet for this long -- without the debounce the
// zero-crossing mid-stroke would split one press into two "moves".
const SETTLE_MS = 250;
// Hood current worth flagging (the robot's own stall cutoff trips at 18 A for 0.5 s).
const HOOD_WARN_AMPS = 15;

// ---- module-scope state (persists across mount/unmount; NT4 won't replay to fresh DOM) ----
let connected = false;
let subsMade = false;

let angle: number | null = null;
let angleTarget: number | null = null;
let angleReached = false;
let rpm: number | null = null;        // flywheel rpm
let rpmTarget: number | null = null;  // flywheel rpm target
let flyAt = false;
let motorRpm: number | null = null;
let motorTarget: number | null = null;
let feederRpm: number | null = null;
let feederAt = false;
let ready = false;
let shooting = false;
let hoodState: string | null = null;
let homingTravel: number | null = null;
let hoodVolts = 0;
let hoodAmps = 0;
let raw: number | null = null;

// Motion tracking, all derived here from the angle samples.
let lastAngle: number | null = null;
let lastStampUs: number | null = null;
let rate = 0; // deg per second
let moving = false;
let moveStartAngle: number | null = null; // angle when the current stroke began
let lastMove: number | null = null; // travel of the last completed stroke
let parkedAngle: number | null = null; // angle the last stroke ended at -- drift is measured off this
let quietSinceMs: number | null = null; // when the rate last dropped below the threshold

let rootEl: HTMLElement | null = null;
const fields = new Map<string, HTMLElement>();
let bannerEl: HTMLElement | null = null;
let tickTimer: number | null = null;

export function mountShooter(container: HTMLElement): void {
  injectStyles();
  build(container);
  ensureShooterSubs();
  render();
}

// ---- one-time style injection (self-contained -- do not touch style.css) ----
function injectStyles(): void {
  if (document.getElementById('sh-styles')) return;
  const style = document.createElement('style');
  style.id = 'sh-styles';
  style.textContent = [
    '.sh-root { display:flex; flex-direction:column; gap:12px; height:100%; box-sizing:border-box;',
    '  padding:14px; overflow:auto; font-family:var(--font-body,"Segoe UI",system-ui,sans-serif);',
    '  color:var(--text,#f2eef8); }',
    '.sh-banner { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px; letter-spacing:1px;',
    '  text-transform:uppercase; padding:6px 10px; border-radius:6px; background:var(--surface-2,#100b17);',
    '  border:1px solid var(--line-soft,#1d1528); color:var(--text-dim,#a99cbe); }',
    '.sh-banner[data-level="bad"] { color:var(--bad,#ff4d5e); border-color:var(--bad,#ff4d5e); }',
    '.sh-banner[data-level="warn"] { color:#ffb347; border-color:#ffb347; }',
    '.sh-banner[data-level="ok"] { color:var(--good,#35d07f); border-color:var(--good,#35d07f); }',
    '.sh-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }',
    '.sh-card { background:var(--surface,#17111f); border:1px solid var(--line-soft,#1d1528);',
    '  border-radius:8px; padding:12px 14px; display:flex; flex-direction:column; gap:8px; }',
    '.sh-card-title { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px;',
    '  letter-spacing:1.5px; text-transform:uppercase; color:var(--accent,#b57bff); }',
    '.sh-big { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:38px; line-height:1;',
    '  color:var(--text,#f2eef8); }',
    '.sh-big[data-live="stale"] { color:var(--text-faint,#6c6182); }',
    '.sh-unit { font-size:14px; color:var(--text-dim,#a99cbe); margin-left:6px; }',
    '.sh-row { display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:8px;',
    '  font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:12px; }',
    '.sh-key { color:var(--text-dim,#a99cbe); }',
    '.sh-val { color:var(--text,#f2eef8); }',
    '.sh-val[data-level="bad"] { color:var(--bad,#ff4d5e); }',
    '.sh-val[data-level="warn"] { color:#ffb347; }',
    '.sh-val[data-level="ok"] { color:var(--good,#35d07f); }',
    '.sh-val[data-level="faint"] { color:var(--text-faint,#6c6182); }',
    '.sh-hint { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;',
    '  color:var(--text-faint,#6c6182); line-height:1.5; }',
  ].join('\n');
  document.head.appendChild(style);
}

// ---- DOM ---------------------------------------------------------------------
function build(container: HTMLElement): void {
  container.textContent = '';
  container.classList.add('sh-root');
  rootEl = container;
  fields.clear();

  const banner = document.createElement('div');
  banner.className = 'sh-banner';
  container.appendChild(banner);
  bannerEl = banner;

  const cards = document.createElement('div');
  cards.className = 'sh-cards';
  container.appendChild(cards);

  cards.appendChild(card('Flywheel', 'rpm', 'flywheel RPM', [
    ['Target (DPAD)', 'rpmTarget'],
    ['Error', 'rpmErr'],
    ['At speed', 'flyAt'],
    ['Motor RPM (actual / target)', 'motorRpm'],
  ]));

  cards.appendChild(card('Feed', 'feeder', 'feeder motor RPM', [
    ['Shooting (RT held)', 'shooting'],
    ['Feeder at speed', 'feederAt'],
    ['Belts (flywheel AND feeder at speed)', 'ready'],
  ]));

  cards.appendChild(card('Hood Angle', 'angle', 'deg', [
    ['State', 'hoodState'],
    ['Target / error', 'angleErr'],
    ['Last move', 'lastMove'],
    ['Drift since parked', 'drift'],
    ['Rate', 'rate'],
    ['Hood volts / amps', 'hoodPower'],
    ['Last homing travel', 'homingTravel'],
    ['Encoder raw (motor rot)', 'raw'],
  ]));

  const hint = document.createElement('div');
  hint.className = 'sh-hint';
  hint.textContent =
    'RT: the belts run only while BOTH the flywheel and the feeder are at speed -- if the belts '
    + 'stay off, the Feed card shows which one is holding them back. HOOD: it homes into its '
    + 'bottom stop on every enable and ignores the DPAD until State = HOMED. A homing travel '
    + 'near 0 means it never actually moved while homing. HOMING_FAILED / STALL_FAULT lock the '
    + 'hood until the next disable -> enable.';
  container.appendChild(hint);
}

/** One readout card: a big primary number plus a list of labelled sub-rows. */
function card(title: string, bigKey: string, unit: string, rows: [string, string][]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sh-card';

  const t = document.createElement('div');
  t.className = 'sh-card-title';
  t.textContent = title;
  el.appendChild(t);

  const big = document.createElement('div');
  big.className = 'sh-big';
  big.textContent = '--';
  const u = document.createElement('span');
  u.className = 'sh-unit';
  u.textContent = unit;
  big.appendChild(u);
  el.appendChild(big);
  fields.set(bigKey, big);

  for (const [label, key] of rows) {
    const row = document.createElement('div');
    row.className = 'sh-row';
    const k = document.createElement('span');
    k.className = 'sh-key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'sh-val';
    v.textContent = '--';
    row.appendChild(k);
    row.appendChild(v);
    el.appendChild(row);
    fields.set(key, v);
  }
  return el;
}

// ---- NT wiring (once ever -- mount() may run many times) ----------------------
function ensureShooterSubs(): void {
  if (subsMade) return;
  subsMade = true;

  onConnection((s) => {
    if (connected === s.connected) return;
    connected = s.connected;
    if (!s.connected) {
      // Every derived number is relative to a session's motion history, and a reconnect may be
      // a different enable (the robot re-datums the hood on every enable). Keeping the old
      // "last move" across that would be a lie, so drop the lot.
      angle = angleTarget = rpm = rpmTarget = raw = null;
      motorRpm = motorTarget = feederRpm = homingTravel = null;
      hoodState = null;
      flyAt = feederAt = ready = shooting = false;
      lastAngle = lastStampUs = lastMove = parkedAngle = moveStartAngle = quietSinceMs = null;
      rate = 0;
      moving = false;
    }
    render();
  });

  onValue(T_ANGLE, (v, tsUs) => {
    trackMotion(Number(v), tsUs);
    angle = Number(v);
    render();
  });
  onValue(T_ANGLE_TARGET, (v) => { angleTarget = Number(v); render(); });
  onValue(T_ANGLE_REACHED, (v) => { angleReached = Boolean(v); render(); });
  onValue(T_FLY, (v) => { rpm = Number(v); render(); });
  onValue(T_FLY_TARGET, (v) => { rpmTarget = Number(v); render(); });
  onValue(T_FLY_AT, (v) => { flyAt = Boolean(v); render(); });
  onValue(T_MOTOR_RPM, (v) => { motorRpm = Number(v); render(); });
  onValue(T_MOTOR_TARGET, (v) => { motorTarget = Number(v); render(); });
  onValue(T_FEEDER, (v) => { feederRpm = Number(v); render(); });
  onValue(T_FEEDER_AT, (v) => { feederAt = Boolean(v); render(); });
  onValue(T_READY, (v) => { ready = Boolean(v); render(); });
  onValue(T_SHOOTING, (v) => { shooting = Boolean(v); render(); });
  onValue(T_HOOD_STATE, (v) => { hoodState = String(v); render(); });
  onValue(T_HOMING_TRAVEL, (v) => { homingTravel = Number(v); render(); });
  onValue(T_HOOD_VOLTS, (v) => { hoodVolts = Number(v); render(); });
  onValue(T_HOOD_AMPS, (v) => { hoodAmps = Number(v); render(); });
  onValue(T_RAW, (v) => { raw = Number(v); render(); });

  // The settle debounce has to expire on its own: the hood stops moving by the robot sending
  // the SAME angle over and over, and NT4 does not resend an unchanged value, so nothing would
  // wake the "stroke finished" transition without a clock of our own.
  if (tickTimer === null) {
    tickTimer = window.setInterval(() => {
      if (settleTick()) render();
    }, 100);
  }
}

/** Feed one angle sample: updates the rate and the moving/parked state machine. */
function trackMotion(sample: number, tsUs: number): void {
  if (!Number.isFinite(sample)) return;
  if (lastAngle !== null && lastStampUs !== null && tsUs > lastStampUs) {
    const dt = (tsUs - lastStampUs) / 1e6;
    // Guard the divide: an out-of-order or duplicated timestamp would otherwise produce an
    // infinite rate and latch the panel into "moving" forever.
    if (dt > 1e-4) rate = (sample - lastAngle) / dt;
  }
  lastAngle = sample;
  lastStampUs = tsUs;
  if (parkedAngle === null) parkedAngle = sample;

  if (Math.abs(rate) >= MOVING_DEG_PER_SEC) {
    if (!moving) {
      moving = true;
      moveStartAngle = parkedAngle ?? sample;
    }
    quietSinceMs = null;
  } else if (moving && quietSinceMs === null) {
    quietSinceMs = Date.now();
  }
}

/**
 * Close out a stroke once the hood has been quiet for SETTLE_MS. Returns true if anything
 * changed, so the caller only re-renders when it must.
 */
function settleTick(): boolean {
  if (!moving || quietSinceMs === null) return false;
  if (Date.now() - quietSinceMs < SETTLE_MS) return false;
  moving = false;
  quietSinceMs = null;
  if (moveStartAngle !== null && lastAngle !== null) lastMove = lastAngle - moveStartAngle;
  parkedAngle = lastAngle;
  moveStartAngle = null;
  rate = 0;
  return true;
}

// ---- rendering ---------------------------------------------------------------
function render(): void {
  if (!rootEl) return;
  renderBanner();

  setBig('angle', angle, 1);
  setBig('rpm', rpm, 0);
  setBig('feeder', feederRpm, 0);

  set('rpmTarget', rpmTarget === null ? '--' : num(rpmTarget, 0) + ' RPM');
  const rpmErr = rpm !== null && rpmTarget !== null ? rpmTarget - rpm : null;
  set('rpmErr', rpmErr === null ? '--' : signed(rpmErr, 0) + ' RPM');
  set('flyAt', flyAt ? 'YES' : 'no', flyAt ? 'ok' : 'faint');
  set('motorRpm', motorRpm === null ? '--'
    : num(motorRpm, 0) + ' / ' + (motorTarget === null ? '--' : num(motorTarget, 0)));

  set('shooting', shooting ? 'YES' : 'no', shooting ? 'warn' : 'faint');
  set('feederAt', feederAt ? 'YES' : 'no', feederAt ? 'ok' : 'faint');
  set('ready', ready ? 'RUNNING' : 'held off', ready ? 'ok' : shooting ? 'warn' : 'faint');

  set('hoodState', hoodState ?? '--', hoodStateLevel());
  const err = angle !== null && angleTarget !== null ? angleTarget - angle : null;
  set('angleErr', angleTarget === null || err === null
    ? '--'
    : num(angleTarget, 1) + ' deg  /  ' + signed(err, 1), angleReached ? 'ok' : undefined);
  set('lastMove', lastMove === null ? '--' : signed(lastMove, 1) + ' deg');
  const drift = angle !== null && parkedAngle !== null && !moving ? angle - parkedAngle : null;
  set('drift', drift === null ? (moving ? 'moving' : '--') : signed(drift, 1) + ' deg',
    drift !== null && Math.abs(drift) >= 2 ? 'bad' : drift !== null && Math.abs(drift) >= 1 ? 'warn' : undefined);
  set('rate', num(rate, 1) + ' deg/s', moving ? 'warn' : 'faint');
  set('hoodPower', num(hoodVolts, 2) + ' V  /  ' + num(hoodAmps, 1) + ' A',
    hoodAmps >= HOOD_WARN_AMPS ? 'bad' : undefined);
  set('homingTravel', homingTravel === null ? '--' : num(homingTravel, 1) + ' deg',
    homingTravel !== null && Math.abs(homingTravel) < 0.5 ? 'warn' : undefined);
  set('raw', raw === null ? '--' : num(raw, 2));
}

function hoodStateLevel(): string | undefined {
  if (hoodState === 'HOMED') return 'ok';
  if (hoodState === 'HOMING') return 'warn';
  if (hoodState === 'HOMING_FAILED' || hoodState === 'STALL_FAULT') return 'bad';
  return 'faint';
}

function renderBanner(): void {
  if (!bannerEl) return;
  if (!connected) {
    bannerEl.textContent = 'No robot connection';
    bannerEl.dataset.level = 'bad';
    return;
  }
  if (angle === null || hoodState === null) {
    bannerEl.textContent = 'Connected — waiting for the launcher to publish';
    bannerEl.dataset.level = 'warn';
    return;
  }
  if (hoodState === 'HOMING_FAILED' || hoodState === 'STALL_FAULT') {
    bannerEl.textContent = 'Hood ' + hoodState.replace('_', ' ').toLowerCase()
      + ' — hood locked until the next disable → enable';
    bannerEl.dataset.level = 'bad';
    return;
  }
  if (hoodState === 'HOMING') {
    bannerEl.textContent = 'Hood homing — DPAD ignored until homed';
    bannerEl.dataset.level = 'warn';
    return;
  }
  if (shooting) {
    bannerEl.textContent = ready ? 'Shooting — belts feeding' : 'Shooting — belts waiting for speed';
    bannerEl.dataset.level = ready ? 'ok' : 'warn';
    return;
  }
  bannerEl.textContent = moving ? 'Hood moving' : 'Hood parked';
  bannerEl.dataset.level = moving ? 'warn' : 'ok';
}

function setBig(key: string, value: number | null, digits: number): void {
  const el = fields.get(key);
  if (!el) return;
  const unit = el.querySelector('.sh-unit');
  el.textContent = value === null ? '--' : num(value, digits);
  if (unit) el.appendChild(unit);
  el.dataset.live = value === null || !connected ? 'stale' : 'live';
}

function set(key: string, text: string, level?: string): void {
  const el = fields.get(key);
  if (!el) return;
  el.textContent = text;
  if (level) el.dataset.level = level;
  else delete el.dataset.level;
}

function num(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '--';
}

function signed(v: number, digits: number): string {
  return (v >= 0 ? '+' : '') + num(v, digits);
}

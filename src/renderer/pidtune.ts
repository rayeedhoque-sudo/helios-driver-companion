// PID Tuning panel: change a gain, the robot applies it within one loop (~20 ms). No rebuild,
// no redeploy.
//
// The robot (frc.robot.util.Tunable) publishes /Tuning/keys + /Tuning/defaults and then only
// READS each gain topic — this panel is the sole writer. That one-way ownership is what keeps a
// typed value from being stomped; the Shuffleboard gain boxes this replaces had both sides
// writing every loop and silently reverted.
//
// The UI is driven entirely off /Tuning/keys, so adding a gain on the robot needs no change here.
//
// NT values are VOLATILE by design: a robot reboot re-seeds every gain from Constants. Making a
// number permanent is a DELIBERATE second step — "Save to Constants" patches the source file via
// main/tuning.ts (it does not deploy, and it does not commit), and "Copy as Java" is the manual
// alternative. Keeping the write explicit preserves reboot-as-undo for exploratory values, and
// keeps the app from rewriting a file you may have open in an editor while you tune.
//
// Writes go through ntPublishVolatile (NOT ntPublish) so the app never replays last session's
// gain onto a freshly booted robot — see the comment on that function.
import { onValue, onConnection, ntPublishVolatile, TOPICS } from './nt';
import { currentDeployTarget, currentDeployPath } from './deploy';

const TUNE = '/Tuning';

// ---- module-scope state (persists across mount/unmount; NT4 won't replay to fresh DOM) ----
let keys: string[] = [];
let defaults: number[] = [];
let roKeys: string[] = [];
const liveValues = new Map<string, number>(); // name (without the /Tuning/ prefix) -> value
const subscribed = new Set<string>(); // per-gain subscriptions, made once ever
let connected = false;
let robotEnabled = false; // FMSControlData bit 0x01 — same derivation as panels.ts
let subsMade = false;

// current DOM refs — reassigned each mount(); may go stale if the panel is closed (harmless).
let rootEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let copyEl: HTMLButtonElement | null = null;
let saveEl: HTMLButtonElement | null = null;
let resultEl: HTMLElement | null = null;
// name -> input, so a live robot value can refresh a field the user is not editing
const inputs = new Map<string, HTMLInputElement>();

export function mountPidTune(container: HTMLElement): void {
  injectStyles();
  build(container);
  ensurePidSubs();
  render();
}

// ---- one-time style injection (self-contained — do not touch style.css) ----
function injectStyles(): void {
  if (document.getElementById('pid-styles')) return;
  const style = document.createElement('style');
  style.id = 'pid-styles';
  style.textContent = [
    '.pid-root { display:flex; flex-direction:column; gap:10px; height:100%; box-sizing:border-box;',
    '  padding:14px; font-family:var(--font-body,"Segoe UI",system-ui,sans-serif); color:var(--text,#f2eef8); }',
    '.pid-banner { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px; letter-spacing:1px;',
    '  text-transform:uppercase; padding:6px 10px; border-radius:6px; background:var(--surface-2,#100b17);',
    '  border:1px solid var(--line-soft,#1d1528); color:var(--text-dim,#a99cbe); }',
    '.pid-banner[data-level="bad"] { color:var(--bad,#ff4d5e); border-color:var(--bad,#ff4d5e); }',
    '.pid-banner[data-level="warn"] { color:#ffb347; border-color:#ffb347; }',
    '.pid-banner[data-level="ok"] { color:var(--good,#35d07f); border-color:var(--good,#35d07f); }',
    '.pid-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:14px; }',
    '.pid-body::-webkit-scrollbar { width:8px; }',
    '.pid-body::-webkit-scrollbar-thumb { background:var(--line,#38294c); border-radius:4px; }',
    '.pid-group-title { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px;',
    '  letter-spacing:1.5px; text-transform:uppercase; color:var(--accent,#b57bff); margin-bottom:6px; }',
    '.pid-row { display:grid; grid-template-columns:1fr 120px 90px 30px; align-items:center; gap:8px; padding:3px 0; }',
    '.pid-name { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:12px; color:var(--text-dim,#a99cbe); }',
    '.pid-input { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:12px;',
    '  color:var(--text,#f2eef8); background:var(--surface,#17111f); border:1px solid var(--line,#38294c);',
    '  border-radius:5px; padding:5px 7px; width:100%; box-sizing:border-box; }',
    '.pid-input:focus { outline:none; border-color:var(--accent,#b57bff); }',
    '.pid-default { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;',
    '  color:var(--text-faint,#6c6182); text-align:right; }',
    '.pid-revert { font-size:12px; line-height:1; color:var(--text-faint,#6c6182); background:none;',
    '  border:1px solid var(--line,#38294c); border-radius:5px; padding:4px 0; cursor:pointer; }',
    '.pid-revert:hover { color:var(--text,#f2eef8); border-color:var(--accent,#b57bff); }',
    '.pid-ro { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:12px; color:var(--text-faint,#6c6182); }',
    '.pid-btn { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px; font-weight:700;',
    '  letter-spacing:1px; text-transform:uppercase; color:#17102a; background:var(--accent,#b57bff);',
    '  border:1px solid var(--accent,#b57bff); border-radius:6px; padding:8px 16px; cursor:pointer; width:fit-content; }',
    '.pid-btn:hover:not(:disabled) { background:#c99cff; }',
    '.pid-btn:disabled { opacity:0.45; cursor:not-allowed; }',
    '.pid-buttons { display:flex; gap:8px; align-items:center; }',
    '.pid-btn-quiet { color:var(--text-dim,#a99cbe); background:var(--surface,#17111f); border-color:var(--line,#38294c); }',
    '.pid-btn-quiet:hover:not(:disabled) { background:var(--surface,#17111f); color:var(--text,#f2eef8); border-color:var(--accent,#b57bff); }',
    '.pid-hint { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;',
    '  color:var(--text-faint,#6c6182); line-height:1.5; }',
  ].join('\n');
  document.head.appendChild(style);
}

// ---- DOM ---------------------------------------------------------------------
function build(container: HTMLElement): void {
  container.textContent = '';
  container.classList.add('pid-root');
  rootEl = container;
  inputs.clear();

  const banner = document.createElement('div');
  banner.className = 'pid-banner';
  container.appendChild(banner);
  bannerEl = banner;

  const body = document.createElement('div');
  body.className = 'pid-body';
  container.appendChild(body);
  bodyEl = body;

  const buttons = document.createElement('div');
  buttons.className = 'pid-buttons';

  const save = document.createElement('button');
  save.className = 'pid-btn';
  save.textContent = 'Save to Constants';
  save.title = 'Write the current gains into SubsystemConstants.java (does not deploy)';
  save.addEventListener('click', onSaveClick);
  buttons.appendChild(save);
  saveEl = save;

  const copy = document.createElement('button');
  copy.className = 'pid-btn pid-btn-quiet';
  copy.textContent = 'Copy as Java';
  copy.title = 'Copy the current gains as constant assignments, to paste by hand instead';
  copy.addEventListener('click', onCopyClick);
  buttons.appendChild(copy);
  copyEl = copy;

  container.appendChild(buttons);

  const result = document.createElement('div');
  result.className = 'pid-hint';
  container.appendChild(result);
  resultEl = result;

  const hint = document.createElement('div');
  hint.className = 'pid-hint';
  hint.textContent =
    'Gains apply within one robot loop, but live only in NetworkTables — a robot reboot '
    + 'restores the compiled constants. "Save to Constants" writes them into the source file; '
    + 'they become the robot default after your next deploy.';
  container.appendChild(hint);
}

// ---- NT wiring (once ever — mount() may run many times) ----------------------
function ensurePidSubs(): void {
  if (subsMade) return;
  subsMade = true;

  onConnection((s) => {
    if (connected === s.connected) return;
    connected = s.connected;
    if (!s.connected) {
      // The robot re-seeds every gain from Constants on boot. Drop what we knew so a stale
      // number can't sit in a field looking authoritative across a reboot.
      liveValues.clear();
      keys = [];
      defaults = [];
      roKeys = [];
    }
    render();
  });

  onValue(TOPICS.fmsControl, (v) => {
    robotEnabled = (Number(v) & 0x01) !== 0;
    renderBanner();
  });

  onValue(TUNE + '/keys', (v) => {
    keys = Array.isArray(v) ? (v as string[]) : [];
    keys.forEach((k) => subscribeGain(k, TUNE + '/' + k));
    render();
  });
  onValue(TUNE + '/defaults', (v) => {
    defaults = Array.isArray(v) ? Array.from(v as number[], Number) : [];
    render();
  });
  onValue(TUNE + '/ro/keys', (v) => {
    roKeys = Array.isArray(v) ? (v as string[]) : [];
    roKeys.forEach((k) => subscribeGain('ro/' + k, TUNE + '/ro/' + k));
    render();
  });
}

function subscribeGain(name: string, topic: string): void {
  if (subscribed.has(name)) return;
  subscribed.add(name);
  onValue(topic, (v) => {
    liveValues.set(name, Number(v));
    refreshValue(name);
  });
}

// ---- rendering ---------------------------------------------------------------
function render(): void {
  if (!rootEl) return;
  renderBanner();
  renderRows();
}

function renderBanner(): void {
  if (!bannerEl) return;
  if (!connected) {
    bannerEl.textContent = 'Not connected to the robot';
    bannerEl.dataset.level = 'bad';
  } else if (keys.length === 0) {
    bannerEl.textContent = 'Tuning mode is OFF — set TUNING_MODE = true in SubsystemConstants and redeploy';
    bannerEl.dataset.level = 'warn';
  } else if (robotEnabled) {
    bannerEl.textContent = 'Robot ENABLED — gain changes take effect immediately';
    bannerEl.dataset.level = 'bad';
  } else {
    bannerEl.textContent = 'Live — ' + keys.length + ' gains';
    bannerEl.dataset.level = 'ok';
  }
  const noGains = keys.length === 0;
  if (copyEl) copyEl.disabled = noGains;
  if (saveEl) {
    saveEl.disabled = noGains;
    saveEl.title = 'Write the current gains into ' + currentDeployPath()
      + '\\src\\main\\java\\frc\\robot\\Constants\\SubsystemConstants.java (does not deploy)';
  }
}

// "Shooter/Flywheel/kP" -> group "Shooter/Flywheel", leaf "kP".
export function splitName(name: string): { group: string; leaf: string } {
  const i = name.lastIndexOf('/');
  return i < 0 ? { group: '', leaf: name } : { group: name.slice(0, i), leaf: name.slice(i + 1) };
}

interface Row {
  name: string;
  leaf: string;
  def: number;
  readOnly: boolean;
}

function renderRows(): void {
  if (!bodyEl) return;
  bodyEl.textContent = '';
  inputs.clear();

  const groups = new Map<string, Row[]>();
  keys.forEach((name, i) => {
    const { group, leaf } = splitName(name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ name, leaf, def: defaults[i] ?? NaN, readOnly: false });
  });
  roKeys.forEach((name) => {
    const { group, leaf } = splitName(name);
    const g = group + ' (read-only)';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ name: 'ro/' + name, leaf, def: NaN, readOnly: true });
  });

  for (const [group, rows] of groups) {
    const section = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'pid-group-title';
    title.textContent = group || 'Ungrouped';
    section.appendChild(title);
    rows.forEach((r) => section.appendChild(buildRow(r)));
    bodyEl.appendChild(section);
  }
}

function buildRow(r: Row): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pid-row';

  const label = document.createElement('div');
  label.className = 'pid-name';
  label.textContent = r.leaf;
  row.appendChild(label);

  if (r.readOnly) {
    const val = document.createElement('div');
    val.className = 'pid-ro';
    val.textContent = fmt(liveValues.get(r.name));
    val.title = 'Redeploy to change — Tuner X / PathPlanner owns this gain';
    row.appendChild(val);
    row.appendChild(document.createElement('div'));
    row.appendChild(document.createElement('div'));
    return row;
  }

  const input = document.createElement('input');
  input.className = 'pid-input';
  input.type = 'number';
  input.step = 'any';
  input.value = fmt(liveValues.get(r.name));
  // 'change', not 'input' — writing on every keystroke would push "0", "0.", "0.8" as you type.
  input.addEventListener('change', () => writeGain(r.name, input));
  inputs.set(r.name, input);
  row.appendChild(input);

  const def = document.createElement('div');
  def.className = 'pid-default';
  def.textContent = Number.isFinite(r.def) ? 'def ' + fmtNum(r.def) : '';
  row.appendChild(def);

  const revert = document.createElement('button');
  revert.className = 'pid-revert';
  revert.textContent = '↺';
  revert.title = 'Revert to the compiled constant (' + fmtNum(r.def) + ')';
  revert.addEventListener('click', () => {
    if (!Number.isFinite(r.def)) return;
    input.value = fmtNum(r.def);
    writeGain(r.name, input);
  });
  row.appendChild(revert);

  return row;
}

// Refresh one field from the robot's value, but never yank the field the user is typing in.
function refreshValue(name: string): void {
  const input = inputs.get(name);
  if (input) {
    if (document.activeElement !== input) input.value = fmt(liveValues.get(name));
    return;
  }
  // read-only rows have no input — cheapest correct thing is a full row re-render
  if (name.startsWith('ro/')) renderRows();
}

function writeGain(name: string, input: HTMLInputElement): void {
  const v = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(v)) {
    // Refuse to send a gain the robot would reject anyway; put the last good value back.
    input.value = fmt(liveValues.get(name));
    return;
  }
  ntPublishVolatile(TUNE + '/' + name, 'double', v);
}

// ---- copy-back ---------------------------------------------------------------
// Maps an NT gain name to the CONSTANT it came from — emitting the NT name (or the
// shooterVelConfigs field name) would paste something that does not compile.
const CONSTANT_NAMES: Record<string, string> = {
  'Shooter/Flywheel/kP': 'SHOOTER_SPEED_kP',
  'Shooter/Flywheel/kI': 'SHOOTER_SPEED_kI',
  'Shooter/Flywheel/kD': 'SHOOTER_SPEED_kD',
  'Shooter/Flywheel/kS': 'SHOOTER_SPEED_kS',
  'Shooter/Flywheel/kV': 'SHOOTER_SPEED_kV',
  'Shooter/Flywheel/kA': 'SHOOTER_SPEED_kA',
  'Shooter/Hood/kP': 'SHOOTER_ANGLE_kP',
  'Shooter/Hood/kI': 'SHOOTER_ANGLE_kI',
  'Shooter/Hood/kD': 'SHOOTER_ANGLE_kD',
  'Drive/Heading/kP': 'HEADING_kP',
  'Drive/Heading/kI': 'HEADING_kI',
  'Drive/Heading/kD': 'HEADING_kD',
};

/** Build the paste-into-SubsystemConstants block. Pure string work; see selfCheck(). */
export function javaBlock(names: string[], values: Map<string, number>): string {
  return names
    .map((n) => {
      const v = values.get(n);
      const constant = CONSTANT_NAMES[n];
      if (!constant) return '// ' + n + ' = ' + fmtNum(v ?? NaN) + ';  // no constant mapped';
      return 'public static double ' + constant + ' = ' + fmtNum(v ?? NaN) + ';';
    })
    .join('\n');
}

/** {constantName: value} for every live gain that maps to a constant, for the source patcher. */
export function gainsByConstant(names: string[], values: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    const constant = CONSTANT_NAMES[n];
    const v = values.get(n);
    if (constant && v !== undefined && Number.isFinite(v)) out[constant] = v;
  }
  return out;
}

async function onSaveClick(): Promise<void> {
  if (!saveEl || !resultEl) return;
  const gains = gainsByConstant(keys, liveValues);
  if (Object.keys(gains).length === 0) {
    showResult('Nothing to save — no gain values read from the robot yet.', 'bad');
    return;
  }
  saveEl.disabled = true;
  try {
    const r = await window.companion.tuning.save(currentDeployTarget(), gains);
    if (!r.ok) {
      showResult('Save failed: ' + (r.error ?? 'unknown error'), 'bad');
      return;
    }
    // Report per-constant so a silently-skipped gain can never look like a successful save.
    const parts: string[] = [];
    if (r.changed.length > 0) {
      parts.push(
        'Wrote ' + r.changed.length + ' to SubsystemConstants.java: '
        + r.changed.map((c) => c.name + ' ' + c.from + ' → ' + c.to).join(', '),
      );
    } else {
      parts.push('No change — the file already matches these gains.');
    }
    const notable = r.skipped.filter((s) => s.reason !== 'already at this value');
    if (notable.length > 0) {
      parts.push('SKIPPED: ' + notable.map((s) => s.name + ' (' + s.reason + ')').join(', '));
    }
    parts.push('Deploy to make it the robot default. Review the diff before committing.');
    showResult(parts.join('  |  '), notable.length > 0 ? 'bad' : 'ok');
  } catch (err) {
    showResult('Save failed: ' + String(err), 'bad');
  } finally {
    saveEl.disabled = keys.length === 0;
  }
}

function showResult(msg: string, level: 'ok' | 'bad'): void {
  if (!resultEl) return;
  resultEl.textContent = msg;
  resultEl.style.color = level === 'ok' ? 'var(--good,#35d07f)' : 'var(--bad,#ff4d5e)';
}

function onCopyClick(): void {
  const text = javaBlock(keys, liveValues);
  void navigator.clipboard.writeText(text).then(
    () => flashCopy('Copied'),
    () => flashCopy('Copy failed'),
  );
}

function flashCopy(msg: string): void {
  if (!copyEl) return;
  const btn = copyEl;
  const prev = btn.textContent;
  btn.textContent = msg;
  window.setTimeout(() => {
    if (btn.isConnected) btn.textContent = prev;
  }, 1200);
}

function fmt(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? '' : fmtNum(v);
}

// Trim float noise (0.12625000000000003) without lying about the value.
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toPrecision(12)));
}

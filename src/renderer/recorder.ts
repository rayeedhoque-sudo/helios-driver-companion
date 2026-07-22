// Motor Recorder panel: pick a motor (grouped by subsystem), hit Record, and the
// panel captures that motor's applied voltage + stator current from
// /CompanionTelemetry (/volts + /stator, 10 Hz from PowerTelemetry.java) until
// Stop. Finished recordings land in a session list and are reviewed on two
// stacked uPlot charts (volts over amps, shared time axis, synced crosshair +
// drag-zoom, double-click resets). Two charts, not one dual-axis chart — two
// measures of different scale never share a y-axis (dataviz rule).
//
// Sampling is a 10 Hz timer over the latest cached NT values (graphs.ts
// pipeline), NOT per-arrival: NT4 only transmits a topic when its value
// CHANGES, so an idle/disabled robot (or the all-zeros sim) would produce no
// arrivals at all. The timer pauses while NT is disconnected so a dead link
// records a visible time gap instead of fake flat data.
//
// Panel-registry contract: mount(container) may run more than once (reopen from
// "+ Panels"), so recordings, the in-flight recording, and the NT subscriptions
// live in MODULE scope behind an ensure guard (same split as panels.ts/deploy.ts)
// — a recording keeps capturing while the tab is closed and the rebuilt DOM
// re-renders from that state.
import uPlot from 'uplot';
import { onValue, getConnState, TOPICS } from './nt';
import { COL_VOLT, COL_CURR } from './graphs';
import { SPEC_NAMES, GROUPS } from './panels';

const T = TOPICS.telemetry;

// Samples arrive at PowerTelemetry's 10 Hz; 36 000 points = a 1 h forgotten
// recording, auto-stopped so an overnight app can't grow without bound.
const MAX_SAMPLES = 36_000;
const MAX_RECORDINGS = 20; // ponytail: session-only in-memory list; add CSV export / disk persistence when the team asks

const AXIS_INK = '#a99cbe';
const GRID = 'rgba(56,41,76,0.55)';
const FONT = '10px "Cascadia Mono", Consolas, monospace';
const LEGEND_H = 26; // uPlot appends its legend below the plot; carve it out of the cell height

export type Recording = {
  idx: number; // NAMES index of the recorded motor
  name: string;
  startedAt: number; // wall clock (Date.now) for the list label
  t: number[]; // seconds since Record was pressed (client clock)
  v: number[]; // applied motor volts (NaN until /volts exists on the robot)
  a: number[]; // stator/output amps
};

// ---- module-scope state (persists across mount/unmount) --------------------
const recordings: Recording[] = []; // finished, newest first
let active: Recording | null = null;
let viewing: Recording | null = null; // what the charts display
let startPerfMs = 0; // performance.now() at Record press — sample time base
let voltsSeen = false; // any finite /volts sample during the active recording
let latestVolts: number[] | null = null;
let latestStator: number[] | null = null;
let chosenIdx = 0; // motor picker selection (persists while panel is closed)

// current DOM/chart refs — reassigned every mount; stale ones are detached (harmless)
let motorSel: HTMLSelectElement | null = null;
let listSel: HTMLSelectElement | null = null;
let recBtn: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;
let hintEl: HTMLElement | null = null;
let uV: uPlot | null = null;
let uA: uPlot | null = null;

export function mountMotorRecorder(container: HTMLElement): void {
  injectStyles();
  build(container);
  ensureRecSubs();
  render();
}

// ---- recording engine -------------------------------------------------------
let recSubscribed = false;
function ensureRecSubs(): void {
  if (recSubscribed) return;
  recSubscribed = true;
  onValue(T + '/volts', (v) => {
    if (Array.isArray(v)) latestVolts = v as number[];
  });
  onValue(T + '/stator', (v) => {
    if (Array.isArray(v)) latestStator = v as number[];
  });
  setInterval(tickRec, 100); // 10 Hz — PowerTelemetry's publish rate
}

function tickRec(): void {
  if (!active) return;
  // No link or no data yet: record nothing (a gap), never a stale flat line.
  if (!getConnState().connected || !latestStator) return;

  const volts = latestVolts?.[active.idx];
  const vVal = typeof volts === 'number' ? volts : NaN;
  if (Number.isFinite(vVal)) voltsSeen = true;
  const aRaw = latestStator[active.idx];
  active.t.push((performance.now() - startPerfMs) / 1000);
  active.v.push(vVal);
  active.a.push(typeof aRaw === 'number' ? aRaw : NaN);

  if (active.t.length >= MAX_SAMPLES) {
    stopRecording();
    return;
  }
  if (viewing === active) setChartData(active);
  renderStatus();
}

function startRecording(): void {
  if (active) return;
  active = {
    idx: chosenIdx,
    name: SPEC_NAMES[chosenIdx] ?? `motor ${chosenIdx}`,
    startedAt: Date.now(),
    t: [],
    v: [],
    a: [],
  };
  startPerfMs = performance.now();
  voltsSeen = false;
  viewing = active;
  setChartData(active);
  render();
}

function stopRecording(): void {
  if (!active) return;
  recordings.unshift(active);
  if (recordings.length > MAX_RECORDINGS) recordings.pop();
  viewing = active; // review what was just captured
  active = null;
  render();
}

// ---- pure label helpers ------------------------------------------------------
export function fmtT(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function recLabel(r: Recording): string {
  const dur = r.t.length ? fmtT(r.t[r.t.length - 1]) : '0s';
  const clock = new Date(r.startedAt).toLocaleTimeString();
  return `${r.name} · ${clock} · ${dur} · ${r.t.length} pts`;
}

// ---- DOM ---------------------------------------------------------------------
function build(container: HTMLElement): void {
  container.textContent = '';
  container.classList.add('rec-root');

  const row = document.createElement('div');
  row.className = 'rec-row';

  motorSel = document.createElement('select');
  motorSel.className = 'rec-select';
  motorSel.title = 'Motor to record';
  for (const g of GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.name;
    for (const i of g.idx) og.appendChild(new Option(SPEC_NAMES[i], String(i)));
    motorSel.appendChild(og);
  }
  motorSel.addEventListener('change', () => {
    chosenIdx = Number(motorSel!.value) || 0;
  });

  recBtn = document.createElement('button');
  recBtn.className = 'rec-btn';
  recBtn.addEventListener('click', () => (active ? stopRecording() : startRecording()));

  listSel = document.createElement('select');
  listSel.className = 'rec-select rec-list';
  listSel.title = 'Session recordings';
  listSel.addEventListener('change', () => {
    const r = recordings[Number(listSel!.value)];
    if (r) {
      viewing = r;
      setChartData(r);
      renderStatus();
    }
  });

  statusEl = document.createElement('span');
  statusEl.className = 'rec-status';

  row.append(motorSel, recBtn, listSel, statusEl);

  hintEl = document.createElement('div');
  hintEl.className = 'rec-hint';
  hintEl.hidden = true;

  const charts = document.createElement('div');
  charts.className = 'rec-charts';
  const cellV = document.createElement('div');
  cellV.className = 'rec-cell';
  const cellA = document.createElement('div');
  cellA.className = 'rec-cell';
  charts.append(cellV, cellA);

  container.append(row, hintEl, charts);

  // Fresh uPlots per mount (old ones sit in a detached container).
  uV?.destroy();
  uA?.destroy();
  const data = viewing ?? { t: [], v: [], a: [] };
  uV = makeChart(cellV, 'Volts', COL_VOLT, voltRange, false, [data.t, data.v]);
  uA = makeChart(cellA, 'Amps', COL_CURR, ampRange, true, [data.t, data.a]);

  for (const [cell, get] of [
    [cellV, () => uV] as const,
    [cellA, () => uA] as const,
  ]) {
    new ResizeObserver(() => get()?.setSize(dims(cell))).observe(cell);
  }
}

// Re-apply all module state to the current DOM (fresh mount, start, stop).
function render(): void {
  if (motorSel) {
    motorSel.value = String(active ? active.idx : chosenIdx);
    motorSel.disabled = !!active;
  }
  if (recBtn) {
    recBtn.textContent = active ? '■ Stop' : '● Record';
    recBtn.dataset.rec = active ? '1' : '0';
  }
  if (listSel) {
    listSel.textContent = '';
    if (!recordings.length) {
      listSel.appendChild(new Option('— no recordings —', ''));
    } else {
      recordings.forEach((r, i) => listSel!.appendChild(new Option(recLabel(r), String(i))));
      const vi = viewing ? recordings.indexOf(viewing) : -1;
      if (vi >= 0) listSel.value = String(vi);
    }
    listSel.disabled = !!active || !recordings.length;
  }
  renderStatus();
}

function renderStatus(): void {
  if (!statusEl) return;
  let text: string;
  let level: string;
  if (active) {
    const dur = active.t.length ? active.t[active.t.length - 1] : 0;
    text = `● REC ${fmtT(dur) || '0s'} · ${active.t.length} pts`;
    level = 'run';
  } else if (viewing) {
    text = `${viewing.t.length} pts`;
    level = 'dim';
  } else {
    text = 'pick a motor, hit Record';
    level = 'dim';
  }
  if (statusEl.textContent !== text) statusEl.textContent = text;
  if (statusEl.dataset.level !== level) statusEl.dataset.level = level;

  if (hintEl) {
    const show = !!active && active.t.length > 0 && !voltsSeen;
    if (hintEl.hidden === show) {
      hintEl.hidden = !show;
      hintEl.textContent = show
        ? 'No /CompanionTelemetry/volts — deploy the latest robot code to get motor voltage (amps still recording).'
        : '';
    }
  }
}

// ---- charts -------------------------------------------------------------------
function setChartData(r: Recording): void {
  uV?.setData([r.t, r.v] as unknown as uPlot.AlignedData);
  uA?.setData([r.t, r.a] as unknown as uPlot.AlignedData);
}

function dims(cell: HTMLElement): { width: number; height: number } {
  return {
    width: Math.max(120, cell.clientWidth),
    height: Math.max(60, cell.clientHeight - LEGEND_H),
  };
}

// Auto y ranges anchored at 0 (motor volts/amps go negative in reverse).
function voltRange(_u: uPlot, min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 13];
  return [Math.min(0, min * 1.05), Math.max(1, max * 1.05)];
}
function ampRange(_u: uPlot, min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 10];
  return [Math.min(0, min * 1.05), Math.max(5, max * 1.05)];
}

// Drag-zoom on one chart re-scales the other so the pair stays one timeline.
let syncingX = false;
function propagateX(src: uPlot): void {
  if (syncingX) return;
  syncingX = true;
  const { min, max } = src.scales.x;
  for (const u of [uV, uA]) {
    if (u && u !== src && min != null && max != null) {
      if (u.scales.x.min !== min || u.scales.x.max !== max) u.setScale('x', { min, max });
    }
  }
  syncingX = false;
}

function makeChart(
  cell: HTMLElement,
  label: string,
  color: string,
  range: (u: uPlot, min: number, max: number) => [number, number],
  showX: boolean,
  data: [number[], number[]],
): uPlot {
  const axis: uPlot.Axis = {
    stroke: AXIS_INK,
    grid: { stroke: GRID, width: 1 },
    ticks: { show: false },
    font: FONT,
    gap: 3,
  };
  const opts: uPlot.Options = {
    ...dims(cell),
    legend: { show: true },
    cursor: {
      sync: { key: 'rec-x' }, // shared crosshair across the volt/amp pair
      drag: { x: true, y: false },
    },
    scales: { x: { time: false }, y: { range } },
    axes: [
      showX
        ? { ...axis, size: 24, space: 60, values: (_u, s) => s.map(fmtT) }
        : { show: false },
      { ...axis, scale: 'y', side: 3, size: 40, space: 22, values: (_u, s) => s.map((v) => String(v)) },
    ],
    series: [
      { label: 't', value: (_u, v) => (v == null ? '—' : fmtT(v)) },
      {
        label,
        stroke: color,
        width: 1.5,
        points: { show: false },
        value: (_u, v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2)),
      },
    ],
    hooks: {
      setScale: [
        (u, key) => {
          if (key === 'x') propagateX(u);
        },
      ],
    },
  };
  return new uPlot(opts, data as unknown as uPlot.AlignedData, cell);
}

// ---- one-time style injection (self-contained — do not touch style.css) ------
function injectStyles(): void {
  if (document.getElementById('rec-styles')) return;
  const style = document.createElement('style');
  style.id = 'rec-styles';
  style.textContent = `
.rec-root { display:flex; flex-direction:column; gap:8px; height:100%; box-sizing:border-box;
  padding:10px; color:var(--text,#f2eef8); }
.rec-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.rec-select { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;
  color:var(--text,#f2eef8); background:var(--surface-2,#100b17);
  border:1px solid var(--line,#38294c); border-radius:6px; padding:6px 8px; max-width:340px; }
.rec-select:disabled { opacity:0.45; }
.rec-btn { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px; font-weight:700;
  letter-spacing:1px; text-transform:uppercase; color:#17102a; background:var(--accent,#b57bff);
  border:1px solid var(--accent,#b57bff); border-radius:6px; padding:7px 14px; cursor:pointer; }
.rec-btn:hover { background:#c99cff; }
.rec-btn[data-rec="1"] { color:var(--bad,#ff4d5e); background:var(--surface,#17111f);
  border-color:var(--bad,#ff4d5e); }
.rec-status { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;
  color:var(--text-dim,#a99cbe); }
.rec-status[data-level="run"] { color:var(--bad,#ff4d5e); }
.rec-hint { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;
  color:var(--accent,#b57bff); }
.rec-charts { flex:1; min-height:0; display:flex; flex-direction:column; gap:6px; }
.rec-cell { flex:1; min-height:0; overflow:hidden; }
.rec-cell .u-legend { font:10px var(--font-mono,"Cascadia Mono",monospace) !important;
  color:var(--text-dim,#a99cbe); text-align:left; }
`;
  document.head.appendChild(style);
}

// Graphs (M5): two rolling uPlot strip charts, each now its own dockview panel.
//   graph-voltage — battery volts, fixed y ~[6, 13.5], guide lines at 12.3 & 6.8 V.
//   graph-current — total pack current (primary) + one optional focus-motor trace.
// 60 s window at 10 Hz = 600 points. Buffers are preallocated Float64Arrays and
// slid with copyWithin each tick (no per-tick array allocation). Timestamps are
// client-side (performance.now) — fine for a rolling view.
//
// mountVoltageGraph(c) / mountCurrentGraph(c) each build a uPlot into the given
// panel container. The shared data pipeline (NT subs + the 10 Hz tick) is started
// once on the first mount via ensureGraphData(); tick() null-guards each chart so
// either panel can be closed/reopened independently. focusMotor() still drives the
// current chart's focus trace + caption.
import uPlot from 'uplot';
import { onValue, TOPICS } from './nt';

const HZ = 10;
const WINDOW_S = 60;
const N = WINDOW_S * HZ; // 600
const DT = 1 / HZ;

// Series identity colors — validated for the dark surface (dataviz):
//   voltage = solar amber (single series, its own chart),
//   total current = alliance blue, focus motor = warm orange (CVD ΔE ~104 vs blue).
const COL_VOLT = '#ffb020';
const COL_CURR = '#3d8bff';
const COL_FOCUS = '#ff9052';
const AXIS_INK = '#8b9bb0'; // --text-dim
const GRID = 'rgba(34,52,73,0.55)'; // --line, translucent
const FONT = '10px "Cascadia Mono", Consolas, monospace';

// Shared rolling timeline (seconds) + one series buffer per trace.
const xs = new Float64Array(N);
const volts = new Float64Array(N);
const curr = new Float64Array(N);
const focus = new Float64Array(N);
// Stable data wrappers reused every setData (uPlot only reads them).
const voltData = [xs, volts] as unknown as uPlot.AlignedData;
const currData = [xs, curr, focus] as unknown as uPlot.AlignedData;

let latestVoltage: number | null = null;
let latestSupply: number[] | null = null;
let latestStator: number[] | null = null;
let focusIdx: number | null = null;
let started = false;

let uVolt: uPlot | null = null;
let uCurr: uPlot | null = null;
let focusCap: HTMLElement | null = null;

// Total pack current approximation: sum /supply where reported; the 4 SparkMax
// slots publish NaN supply, so fall back to their /stator (output) current there.
// This mixes bus-current (Talon supply) with output-current (Spark stator) — an
// approximation of true pack draw, but the only per-motor number the Sparks give.
export function totalCurrent(supply: number[] | null, stator: number[] | null): number {
  if (!supply || !stator) return NaN;
  let sum = 0;
  const n = Math.min(supply.length, stator.length);
  for (let i = 0; i < n; i++) {
    sum += Number.isNaN(supply[i]) ? (Number.isNaN(stator[i]) ? 0 : stator[i]) : supply[i];
  }
  return sum;
}

// Voltage strip chart -> its own panel container.
export function mountVoltageGraph(host: HTMLElement): void {
  host.classList.add('graph-panel');
  host.textContent = '';
  uVolt?.destroy(); // reopening from the + menu: drop the old (detached) instance
  uVolt = new uPlot(voltageOpts(dims(host)), voltData, host);
  new ResizeObserver(() => {
    if (uVolt) uVolt.setSize(dims(host));
  }).observe(host);
  ensureGraphData();
}

// Current strip chart (+ focus trace) -> its own panel container.
export function mountCurrentGraph(host: HTMLElement): void {
  host.classList.add('graph-panel');
  host.textContent = '';
  uCurr?.destroy();
  uCurr = new uPlot(currentOpts(dims(host)), currData, host);

  // Focus caption (secondary encoding so the highlight isn't color-alone).
  focusCap = document.createElement('div');
  focusCap.className = 'graph-focus-cap';
  focusCap.hidden = true;
  host.appendChild(focusCap);
  focusMotor(focusIdx); // reflect any existing focus selection in the fresh caption

  new ResizeObserver(() => {
    if (uCurr) uCurr.setSize(dims(host));
  }).observe(host);
  ensureGraphData();
}

// NT subscriptions + the 10 Hz sampling tick — started once, shared by both charts.
let dataStarted = false;
function ensureGraphData(): void {
  if (dataStarted) return;
  dataStarted = true;

  onValue(TOPICS.telemetry + '/voltage', (v) => {
    if (typeof v === 'number') latestVoltage = v;
  });
  onValue(TOPICS.telemetry + '/supply', (v) => {
    if (Array.isArray(v)) latestSupply = v as number[];
  });
  onValue(TOPICS.telemetry + '/stator', (v) => {
    if (Array.isArray(v)) latestStator = v as number[];
  });

  setInterval(tick, 1000 / HZ);
}

// panels.ts calls this when a motor row is clicked (index) or cleared (null).
export function focusMotor(index: number | null): void {
  focusIdx = index;
  if (!focusCap) return;
  if (index == null) {
    focusCap.hidden = true;
  } else {
    focusCap.hidden = false;
    focusCap.textContent = `focus · motor ${index}`;
  }
}

function tick(): void {
  if (latestVoltage == null) return; // wait for first real sample
  const t = performance.now() / 1000;
  const c = totalCurrent(latestSupply, latestStator);
  const cVal = Number.isNaN(c) ? 0 : c;
  const fVal =
    focusIdx != null && latestStator && !Number.isNaN(latestStator[focusIdx])
      ? latestStator[focusIdx]
      : NaN;

  if (!started) {
    // Prefill a full window so the chart is valid immediately (flat until real
    // variation arrives). Focus starts empty (NaN => nothing drawn).
    for (let i = 0; i < N; i++) {
      xs[i] = t - (N - 1 - i) * DT;
      volts[i] = latestVoltage;
      curr[i] = cVal;
      focus[i] = NaN;
    }
    started = true;
  } else {
    xs.copyWithin(0, 1);
    volts.copyWithin(0, 1);
    curr.copyWithin(0, 1);
    focus.copyWithin(0, 1);
    xs[N - 1] = t;
    volts[N - 1] = latestVoltage;
    curr[N - 1] = cVal;
    focus[N - 1] = fVal;
  }

  if (uVolt) uVolt.setData(voltData); // resetScales=true -> x window scrolls, y pinned
  if (uCurr) uCurr.setData(currData);
}

function dims(host: HTMLElement): { width: number; height: number } {
  return { width: Math.max(120, host.clientWidth), height: Math.max(60, host.clientHeight) };
}

function yAxis(fmt: (v: number) => string): uPlot.Axis {
  return {
    scale: 'y',
    side: 3,
    stroke: AXIS_INK,
    grid: { stroke: GRID, width: 1 },
    ticks: { show: false },
    font: FONT,
    size: 30,
    gap: 3,
    space: 22,
    values: (_u, splits) => splits.map(fmt),
  };
}

const xAxisHidden: uPlot.Axis = { show: false };

function voltageOpts(d: { width: number; height: number }): uPlot.Options {
  return {
    ...d,
    legend: { show: false },
    cursor: { show: false },
    padding: [6, 6, 2, 0],
    scales: { x: { time: false }, y: { range: [6, 13.5] } },
    axes: [xAxisHidden, yAxis((v) => v.toFixed(0))],
    series: [
      {},
      { stroke: COL_VOLT, width: 1.5, fill: 'rgba(255,176,32,0.10)', points: { show: false } },
    ],
    hooks: {
      draw: [
        (u) => {
          // Subtle reference lines: 12.3 V nominal load, 6.8 V roboRIO brownout.
          drawGuide(u, 12.3, 'rgba(139,155,176,0.35)');
          drawGuide(u, 6.8, 'rgba(255,77,94,0.45)');
        },
      ],
    },
  };
}

function currentOpts(d: { width: number; height: number }): uPlot.Options {
  return {
    ...d,
    legend: { show: false },
    cursor: { show: false },
    padding: [6, 6, 2, 0],
    scales: {
      x: { time: false },
      // Auto range from the total series only, 0-anchored with a little headroom.
      y: { range: (_u, _min, max) => [0, Math.max(20, max * 1.1)] },
    },
    axes: [xAxisHidden, yAxis((v) => v.toFixed(0))],
    series: [
      {},
      { stroke: COL_CURR, width: 1.5, fill: 'rgba(61,139,255,0.10)', points: { show: false } },
      // Focus trace: auto:false so an all-NaN (unfocused) buffer never poisons the scale.
      { stroke: COL_FOCUS, width: 1.5, auto: false, points: { show: false } },
    ],
  };
}

function drawGuide(u: uPlot, val: number, color: string): void {
  const ctx = u.ctx;
  const y = Math.round(u.valToPos(val, 'y', true)) + 0.5;
  if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(u.bbox.left, y);
  ctx.lineTo(u.bbox.left + u.bbox.width, y);
  ctx.stroke();
  ctx.restore();
}

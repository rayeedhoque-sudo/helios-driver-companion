// Geometry self-check for the field-clipping fix. Run: `node tools/geom-selfcheck.mjs`
// Bundles the REAL exported transforms from src/renderer/field.ts (computeLayout /
// fieldToCanvasAt) via esbuild -> node, stubbing ./nt + ./store (only used inside
// functions this check never calls). Then, for every mode + rendered station, computes
// the wall-edge decoration draw extents (field YOU marker; laptop-map icon + YOU label)
// and asserts they lie fully inside the canvas rect. Fails (nonzero exit) on any clip.
//
// This is the guard behind the MARGIN inset in computeLayout: if that margin is ever
// removed or a decoration grows past it, this check fails.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // driver-companion/

const stub = {
  name: 'stub-nt-store',
  setup(b) {
    b.onResolve({ filter: /\.\/(nt|store)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        export const onSettings=()=>{};
        export const getSettings=()=>({station:'B1'});
        export const updateSettings=async()=>{};
        export const onValue=()=>()=>{};
        export const onConnection=()=>{};
        export const decodeSwerveModuleStates=()=>[];
        export const TOPICS={pose:'',moduleStates:'',isRedAlliance:'',stationNumber:'',fmsControl:''};
      `,
      loader: 'js',
    }));
  },
};

const res = await build({
  entryPoints: [path.join(ROOT, 'src/renderer/field.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [stub],
  logLevel: 'silent',
});
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(res.outputFiles[0].text).toString('base64')
);
const { computeLayout, fieldToCanvasAt, radarOffset } = mod;

// Radar-offset spot checks (orientation panel): bearing 0 = FORWARD = up (-dy),
// +90 = driver's LEFT (-dx), 180 = BEHIND = down (+dy); any distance stays inside R.
{
  const R = 100;
  const near = (v, want) => Math.abs(v - want) < 1e-9;
  const must = (ok, msg, got) => {
    if (!ok) {
      console.log(`RESULT: FAIL (radar) — ${msg}`, got);
      process.exit(1);
    }
  };
  const fwd = radarOffset(0, 3, R); // 3 m = mid-ring by the soft scale
  const left = radarOffset(90, 3, R);
  const behind = radarOffset(180, 3, R);
  const far = radarOffset(0, 1e6, R);
  must(near(fwd.dx, 0) && near(fwd.dy, -50), 'forward should be up at mid-ring', fwd);
  must(near(left.dx, -50) && near(left.dy, 0), '+90 should be left', left);
  must(near(behind.dx, 0) && near(behind.dy, 50), '180 should be down (behind)', behind);
  must(Math.hypot(far.dx, far.dy) < R, 'any distance stays inside the ring', far);
  console.log('radar-offset spot checks: PASS');
}

const FIELD_W_M = 16.535;
const FIELD_H_M = 8.069;
const STATION_Y_FRAC = { '1': 5 / 6, '2': 1 / 2, '3': 1 / 6 };

// Draw-extent padding (px) mirroring the actual draw code in field.ts.
// YOU marker (drawYouMarker): dot r=5; "YOU" label at at.y-9, 10px bold (est).
const YOU = { dotR: 5, labelDy: 9, labelHalfW: 12, ascent: 9, descent: 3 };
// Laptop icon (drawLaptop): base x +/-23; screen top -24; base bottom +4;
//   "YOU · Rn" label at at.y-30, 12px bold (est half-width 26, ascent 10, descent 3).
const LAP = { halfW: 26, top: -40, bottom: 4 };

function stationPoint(st) {
  const isRed = st.startsWith('R');
  return { x: isRed ? FIELD_W_M : 0, y: STATION_Y_FRAC[st[1]] * FIELD_H_M };
}

function youExtent(mode, st, cssW, cssH) {
  const l = computeLayout(mode, cssW, cssH);
  const p = stationPoint(st);
  const at = fieldToCanvasAt(l, p.x, p.y);
  return {
    minX: at.x - Math.max(YOU.dotR, YOU.labelHalfW),
    maxX: at.x + Math.max(YOU.dotR, YOU.labelHalfW),
    minY: Math.min(at.y - YOU.dotR, at.y - YOU.labelDy - YOU.ascent),
    maxY: Math.max(at.y + YOU.dotR, at.y - YOU.labelDy + YOU.descent),
  };
}

function laptopExtent(st, cssW, cssH) {
  const mode = st.startsWith('B') ? 'driverBlue' : 'driverRed';
  const l = computeLayout(mode, cssW, cssH);
  const p = stationPoint(st);
  const at = fieldToCanvasAt(l, p.x, p.y);
  return { minX: at.x - LAP.halfW, maxX: at.x + LAP.halfW, minY: at.y + LAP.top, maxY: at.y + LAP.bottom };
}

const SIZES = [
  [720, 980], // ~default field/map panel
  [900, 700],
  [1200, 900],
  [400, 700],
  [700, 400],
  [300, 600],
  [600, 300],
  [250, 250], // stress: small square
];

// Combos that actually render a YOU marker (currentMode()): full shows both alliances;
// each driver mode shows only its own alliance's stations.
const YOU_CASES = [
  ['full', 'R1'], ['full', 'R2'], ['full', 'R3'],
  ['full', 'B1'], ['full', 'B2'], ['full', 'B3'],
  ['driverBlue', 'B1'], ['driverBlue', 'B2'], ['driverBlue', 'B3'],
  ['driverRed', 'R1'], ['driverRed', 'R2'], ['driverRed', 'R3'],
];
const LAP_CASES = ['B1', 'B2', 'B3', 'R1', 'R2', 'R3'];

let fails = 0;
let tightest = Infinity;
let tightestWhere = '';

function assertInside(tag, e, cssW, cssH) {
  const clearance = Math.min(e.minX, e.minY, cssW - e.maxX, cssH - e.maxY);
  if (clearance < tightest) {
    tightest = clearance;
    tightestWhere = tag;
  }
  const ok = e.minX >= 0 && e.minY >= 0 && e.maxX <= cssW && e.maxY <= cssH;
  if (!ok) {
    fails++;
    console.log(
      `  FAIL ${tag}: extent x[${e.minX.toFixed(1)},${e.maxX.toFixed(1)}] y[${e.minY.toFixed(1)},${e.maxY.toFixed(1)}] vs ${cssW}x${cssH}`,
    );
  }
}

for (const [cssW, cssH] of SIZES) {
  for (const [mode, st] of YOU_CASES) {
    assertInside(`YOU ${mode}/${st} @${cssW}x${cssH}`, youExtent(mode, st, cssW, cssH), cssW, cssH);
  }
  for (const st of LAP_CASES) {
    assertInside(`LAPTOP ${st} @${cssW}x${cssH}`, laptopExtent(st, cssW, cssH), cssW, cssH);
  }
}

const total = SIZES.length * (YOU_CASES.length + LAP_CASES.length);
console.log(`geom-selfcheck: ${total} extent checks across ${SIZES.length} sizes`);
console.log(`tightest clearance to a canvas edge: ${tightest.toFixed(1)}px  (${tightestWhere})`);
for (const [mode, st] of [['driverBlue', 'B1'], ['driverRed', 'R1']]) {
  const e = youExtent(mode, st, 720, 980);
  console.log(`  YOU ${mode}/${st} @720x980: x[${e.minX.toFixed(1)},${e.maxX.toFixed(1)}] y[${e.minY.toFixed(1)},${e.maxY.toFixed(1)}]`);
}
for (const st of ['B1', 'R1']) {
  const e = laptopExtent(st, 720, 980);
  console.log(`  LAPTOP ${st} @720x980: x[${e.minX.toFixed(1)},${e.maxX.toFixed(1)}] y[${e.minY.toFixed(1)},${e.maxY.toFixed(1)}]`);
}

if (fails > 0) {
  console.log(`RESULT: FAIL (${fails} clipping violations)`);
  process.exit(1);
}
console.log('RESULT: PASS — all wall-edge decorations inside the canvas in every mode/station');

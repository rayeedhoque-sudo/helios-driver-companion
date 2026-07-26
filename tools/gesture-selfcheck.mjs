// Self-check for the gesture classifier's finger-counting geometry.
// Run: `node tools/gesture-selfcheck.mjs`
//
// Bundles the REAL exported extendedCount() from src/renderer/gestures.ts (via
// esbuild -> node, stubbing @mediapipe/tasks-vision, which is only touched inside
// functions this check never calls) and asserts it counts synthetic hands correctly.
//
// This is the guard behind the 1.08 margin in extendedCount: that margin is what
// stops a half-curled finger from registering. Drop it and the "marginal finger"
// case below fails, which on the robot means gestures firing at random.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // driver-companion/

const stub = {
  name: 'stub-mediapipe',
  setup(b) {
    b.onResolve({ filter: /@mediapipe\/tasks-vision/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const FilesetResolver={forVisionTasks:async()=>({})};
                 export const HandLandmarker={createFromOptions:async()=>({})};`,
      loader: 'js',
    }));
  },
};

const res = await build({
  entryPoints: [path.join(ROOT, 'src/renderer/gestures.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [stub],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(res.outputFiles[0].text).toString('base64')}`);
const { extendedCount, classify, reset, DWELL_FRAMES, SWIPE_ARM_FRAMES, COOLDOWN_MS, SWIPE_DX } = mod.__test;

// Build a 21-landmark hand. `reach` maps finger name -> tip distance from the wrist;
// the middle joint always sits at 0.10. Extended fingers reach past it, curled ones
// fall short. Everything is a straight line out of the wrist — orientation doesn't
// matter to extendedCount, only radial distance does.
const JOINT = { thumb: 2, index: 6, middle: 10, ring: 14, pinky: 18 };
const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const JOINT_R = 0.1;

function hand(reach) {
  const wrist = { x: 0.5, y: 0.9, z: 0 };
  const lm = Array.from({ length: 21 }, () => ({ ...wrist }));
  let i = 0;
  for (const f of Object.keys(JOINT)) {
    // Fan the fingers out so no two share a point; angle is irrelevant to the math.
    const a = -Math.PI / 2 + (i - 2) * 0.2;
    i++;
    const at = (r) => ({ x: wrist.x + Math.cos(a) * r, y: wrist.y + Math.sin(a) * r, z: 0 });
    lm[JOINT[f]] = at(JOINT_R);
    lm[TIP[f]] = at(reach[f] ?? 0.04); // default: curled
  }
  return lm;
}

const EXT = 0.2; // comfortably extended
const cases = [
  ['fist', {}, 0],
  ['index only', { index: EXT }, 1],
  ['peace sign', { index: EXT, middle: EXT }, 2],
  ['three fingers', { index: EXT, middle: EXT, ring: EXT }, 3],
  ['open palm', { thumb: EXT, index: EXT, middle: EXT, ring: EXT, pinky: EXT }, 5],
  ['four fingers (swipe pose)', { index: EXT, middle: EXT, ring: EXT, pinky: EXT }, 4],
  // The margin guard: a finger only 5% past its joint is half-curled, not extended.
  // Without the 1.08 factor this would count as 1 and gestures would self-trigger.
  ['marginal finger', { index: JOINT_R * 1.05 }, 0],
];

let failed = 0;
for (const [name, reach, want] of cases) {
  const got = extendedCount(hand(reach));
  try {
    assert.equal(got, want, `${name}: expected ${want} extended, got ${got}`);
    console.log(`  ok   ${name} -> ${got}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${err.message}`);
  }
}

// ---- classify(): the part that actually fires actions ------------------------
// Drives synthetic frame sequences through the real classifier with a stubbed
// action sink and an explicit clock, so dwell / cooldown / swipe-arming are pinned.
// None of this is reachable by a live camera test.
const OPEN = { thumb: EXT, index: EXT, middle: EXT, ring: EXT, pinky: EXT };

function recorder() {
  const fired = [];
  return {
    fired,
    openNth: (n) => fired.push(`open:${n}`),
    focusNext: () => fired.push('next'),
    focusPrev: () => fired.push('prev'),
  };
}

// Feed `frames` (each: {reach, x}) at 1/DETECT_HZ intervals. x shifts the whole hand
// horizontally to simulate travel; MediaPipe x is normalized and gestures.ts mirrors it.
function run(frames, startAt = 10_000) {
  const act = recorder();
  reset();
  let t = startAt;
  for (const f of frames) {
    const lm = hand(f.reach).map((p) => ({ ...p, x: p.x + (f.x ?? 0) }));
    classify({ landmarks: [lm] }, act, t);
    t += 1000 / 12; // DETECT_HZ
  }
  return act.fired;
}

const rep = (n, frame) => Array.from({ length: n }, () => frame);

function check(name, got, want) {
  try {
    assert.deepEqual(got, want, `${name}: expected [${want}], got [${got}]`);
    console.log(`  ok   ${name} -> [${got}]`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${err.message}`);
  }
}

console.log('\nclassify() — dwell, cooldown, swipe arming:');

// A count held past DWELL_FRAMES fires exactly once, not once per frame.
check(
  'two fingers held fires once',
  run(rep(DWELL_FRAMES + 6, { reach: { index: EXT, middle: EXT } })),
  ['open:2'],
);

// Held below the dwell threshold: nothing. This is the flicker guard.
check('two fingers held briefly does nothing', run(rep(DWELL_FRAMES - 1, { reach: { index: EXT, middle: EXT } })), []);

// Changing the count restarts the dwell — a hand in transit must not fire.
check(
  'count changing mid-dwell does not fire',
  run([
    ...rep(DWELL_FRAMES - 1, { reach: { index: EXT } }),
    ...rep(DWELL_FRAMES - 1, { reach: { index: EXT, middle: EXT } }),
  ]),
  [],
);

// Open palm travelling right -> exactly one 'next', despite many qualifying frames.
const travel = (n, total) => Array.from({ length: n }, (_, i) => ({ reach: OPEN, x: -(total * i) / (n - 1) }));
check('open palm swipe fires once', run([...rep(SWIPE_ARM_FRAMES, { reach: OPEN }), ...travel(5, SWIPE_DX + 0.06)]), [
  'next',
]);

// THE REGRESSION GUARD for the arming gate: a hand crossing the whole frame fast,
// with no preceding pose hold — an arm reaching past the laptop, a coach gesturing
// over it. The arming gate eats the opening frames, so the trail never reaches the
// 3 samples a swipe needs. Frame count is a literal, NOT derived from
// SWIPE_ARM_FRAMES, so the case stays meaningful if that constant is tuned.
// Verified non-vacuous: with SWIPE_ARM_FRAMES = 0 this returns ['next'].
check('fast sweep with no pose hold does not fire', run(travel(5, 0.9)), []);

// The realistic version of the same hazard, and the case the stillness check exists
// for: an arm crossing the frame over ~1 s at 12 Hz is ~12 frames — long enough that
// a plain N-frame arming delay lapses and the trail still fills. Only requiring the
// palm to PAUSE first rejects it.
// Verified non-vacuous: with SWIPE_STILL_DX = 999 this returns ['next'].
check('slow arm crossing the frame does not fire', run(travel(12, 0.9)), []);

// Cooldown: a second gesture immediately after a fire is swallowed.
check(
  'cooldown swallows an immediate second gesture',
  run([
    ...rep(DWELL_FRAMES, { reach: { index: EXT } }),
    ...rep(DWELL_FRAMES + 2, { reach: { index: EXT, middle: EXT } }),
  ]),
  ['open:1'],
);

// Losing the hand clears dwell — frames either side of a gap must not accumulate.
{
  const act = recorder();
  reset();
  let t = 10_000;
  const feed = (lm) => {
    classify({ landmarks: lm ? [lm] : [] }, act, t);
    t += 1000 / 12;
  };
  for (let i = 0; i < DWELL_FRAMES - 1; i++) feed(hand({ index: EXT }));
  feed(null); // hand leaves frame
  for (let i = 0; i < DWELL_FRAMES - 1; i++) feed(hand({ index: EXT }));
  check('hand leaving frame resets dwell', act.fired, []);
}

console.log(failed ? `\n${failed} case(s) failed` : '\ngesture self-check passed');
process.exit(failed ? 1 : 0);

// Self-check for the gesture classifier's finger-counting geometry.
// Run: `node tools/gesture-selfcheck.mjs`
//
// Bundles the REAL exported extendedCount() from src/renderer/gestures.ts (via
// esbuild -> node, stubbing @mediapipe/tasks-vision, which is only touched inside
// functions this check never calls) and asserts it counts synthetic hands correctly.
//
// Two layers: extendedCount() against static poses, then classify() against
// synthetic frame sequences (dwell, cooldown, swipe arming) with a stubbed action
// sink. Every guard here has been mutation-checked — flipping the constant it
// protects makes its case fail — so none of them are vacuous.
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
const {
  extendedCount,
  classify,
  reset,
  DETECT_HZ,
  DWELL_FRAMES,
  SWIPE_ARM_FRAMES,
  SWIPE_DX,
  SWIPE_WINDOW_MS,
  SWIPE_STILL_SPEED,
  SWIPE_REVERSE_LOCK_MS,
} = mod.__test;

// Build a 21-landmark hand, laid out like a real one seen palm-on with the fingers
// pointing up. Landmark ids are MediaPipe's.
//
// The thumb is modelled SEPARATELY and faithfully, and that matters: an earlier
// version of this file fanned all five digits radially out of the wrist and let a
// "curled" thumb fall short like a finger. Real thumbs don't do that — they fold
// ACROSS the palm, ending up further from the wrist than their own base joint. That
// unfaithful model is why this check passed while a real fist opened panel 1 on
// camera. Keep the tucked thumb tip up-and-across (not short), or the check goes
// blind to the exact bug it now guards.
const wrist = { x: 0.5, y: 0.9, z: 0 };
const MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };
const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };
const TIP = { index: 8, middle: 12, ring: 16, pinky: 20 };
const COL = { index: 0.46, middle: 0.5, ring: 0.54, pinky: 0.58 };
const P = (x, y) => ({ x, y, z: 0 });

// ext: array of digit names that are extended. marginal: one finger placed just
// barely past its PIP — half-curled, must NOT count.
function hand(ext = [], marginal = null) {
  const lm = Array.from({ length: 21 }, () => ({ ...wrist }));
  lm[0] = { ...wrist };

  for (const f of Object.keys(MCP)) {
    const x = COL[f];
    lm[MCP[f]] = P(x, 0.8);
    lm[PIP[f]] = P(x, 0.72);
    if (f === marginal) {
      // Tip only 3% further from the wrist than the PIP — inside FINGER_MARGIN.
      const pip = lm[PIP[f]];
      lm[TIP[f]] = P(wrist.x + (pip.x - wrist.x) * 1.03, wrist.y + (pip.y - wrist.y) * 1.03);
    } else {
      lm[TIP[f]] = P(x, ext.includes(f) ? 0.62 : 0.78); // 0.78 = curled back to the palm
    }
  }

  // Thumb chain on the far side from the pinky.
  lm[1] = P(0.44, 0.86);
  lm[2] = P(0.4, 0.82);
  lm[3] = P(0.37, 0.78);
  // Extended: out to the side, away from the pinky MCP.
  // Tucked: folded up across the palm — FURTHER from the wrist than joint 2, which
  // is precisely what fooled the old radial test.
  lm[4] = ext.includes('thumb') ? P(0.33, 0.74) : P(0.48, 0.74);
  return lm;
}

const cases = [
  // --- the on-camera regressions (2026-07-25): every count read one too high ---
  ['fist, thumb tucked', [], null, 0],
  ['thumb tucked + index out', ['index'], null, 1],
  // --- the rest of the vocabulary ---
  ['thumb out only', ['thumb'], null, 1],
  ['peace sign', ['index', 'middle'], null, 2],
  ['three fingers', ['index', 'middle', 'ring'], null, 3],
  ['four fingers, thumb tucked (swipe pose)', ['index', 'middle', 'ring', 'pinky'], null, 4],
  ['open palm, all five', ['thumb', 'index', 'middle', 'ring', 'pinky'], null, 5],
  // The margin guard: a finger only 3% past its joint is half-curled, not extended.
  // Without FINGER_MARGIN this counts as 1 and gestures self-trigger.
  ['marginal half-curled finger', [], 'index', 0],
];

let failed = 0;
for (const [name, ext, marginal, want] of cases) {
  const got = extendedCount(hand(ext, marginal));
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
const OPEN = ['thumb', 'index', 'middle', 'ring', 'pinky'];

function recorder() {
  const fired = [];
  return {
    fired,
    openNth: (n) => fired.push(`open:${n}`),
    focusNext: () => fired.push('next'),
    focusPrev: () => fired.push('prev'),
  };
}

// Feed `frames` (each: {ext, x}) at 1/DETECT_HZ intervals. x shifts the whole hand
// horizontally to simulate travel; MediaPipe x is normalized and gestures.ts mirrors it.
function run(frames, startAt = 10_000) {
  const act = recorder();
  reset();
  let t = startAt;
  for (const f of frames) {
    const lm = hand(f.ext).map((p) => ({ ...p, x: p.x + (f.x ?? 0) }));
    classify({ landmarks: [lm] }, act, t);
    t += 1000 / DETECT_HZ;
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
  run(rep(DWELL_FRAMES + 6, { ext: ['index','middle'] })),
  ['open:2'],
);

// Held below the dwell threshold: nothing. This is the flicker guard.
check('two fingers held briefly does nothing', run(rep(DWELL_FRAMES - 1, { ext: ['index','middle'] })), []);

// Changing the count restarts the dwell — a hand in transit must not fire.
check(
  'count changing mid-dwell does not fire',
  run([
    ...rep(DWELL_FRAMES - 1, { ext: ['index'] }),
    ...rep(DWELL_FRAMES - 1, { ext: ['index','middle'] }),
  ]),
  [],
);

// Open palm travelling right -> 'next'. `from` lets a stroke start where the last
// one ended, so return strokes can be modelled.
const travel = (n, total, ext = OPEN, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ ext, x: from - (total * i) / (n - 1) }));
// Still frames at x, long enough to arm.
const armAt = (x = 0) => rep(SWIPE_ARM_FRAMES, { ext: OPEN, x });

check('open palm swipe fires once', run([...armAt(), ...travel(5, SWIPE_DX + 0.06)]), ['next']);

// THE REGRESSION GUARD for the arming gate: a hand crossing the whole frame fast,
// with no preceding pose hold — an arm reaching past the laptop, a coach gesturing
// over it. It never holds still, so it never arms.
// Verified non-vacuous: with SWIPE_ARM_FRAMES = 0 this returns ['next'].
check('fast sweep with no pose hold does not fire', run(travel(5, 0.9)), []);

// The realistic version of the same hazard, and the case the stillness check exists
// for: an arm crossing the frame over ~1 s is slow enough that a plain N-frame
// arming delay would lapse and the trail still fill. Only requiring the palm to
// PAUSE first rejects it.
// Verified non-vacuous: with SWIPE_STILL_SPEED = 999 this returns ['next'].
check('slow arm crossing the frame does not fire', run(travel(12, 0.9)), []);

// ---- reported on camera 2026-07-25: swipes were slow, one-shot, and dropped out --
// Each case below is one of those complaints.

// "I should be able to swipe through multiple tabs with the same palm." One
// continuous sweep must keep advancing, not stop after the first tab.
{
  const fired = run([...armAt(), ...travel(24, 1.0)]);
  const ok = fired.length >= 2 && fired.every((f) => f === 'next');
  try {
    assert.ok(ok, `expected >=2 consecutive 'next', got [${fired}]`);
    console.log(`  ok   continuous sweep advances repeatedly -> [${fired}]`);
  } catch (err) {
    failed++;
    console.error(`  FAIL continuous sweep advances repeatedly: ${err.message}`);
  }
}

// "after every swipe i have to take my palm off the camera and restart". Bringing
// the hand back for a second swipe must not fire the opposite direction and undo it.
// The return is deliberately UNHURRIED (10 frames ~ 420 ms) so it outlasts
// SWIPE_REPEAT_MS and actually reaches the reverse lock — a snappier return is
// swallowed by the repeat gate and would test nothing. Frame count is a literal,
// not derived from either constant.
// Verified non-vacuous: with SWIPE_REVERSE_LOCK_MS = 0 this returns ['next','prev'].
check(
  'return stroke does not undo the swipe',
  run([...armAt(), ...travel(5, SWIPE_DX + 0.06), ...travel(10, -(SWIPE_DX + 0.06), OPEN, -(SWIPE_DX + 0.06))]),
  ['next'],
);

// "a slight sweep motion which overlaps fingers and doesnt make all 5 visible".
// Once armed, the count may collapse to 2 mid-sweep and the swipe must survive.
check(
  'swipe survives fingers merging mid-sweep',
  run([...armAt(), ...travel(5, SWIPE_DX + 0.06, ['index', 'middle'])]),
  ['next'],
);

// "i should be able to swipe fast while still getting recognized". A sweep over
// only SWIPE_MIN_SAMPLES frames must still register.
check('fast two-sample swipe registers', run([...armAt(), ...travel(2, SWIPE_DX + 0.06)]), ['next']);

// A deliberate reversal after the lock expires is still a real gesture.
{
  const pause = Math.ceil((SWIPE_REVERSE_LOCK_MS / 1000) * DETECT_HZ) + 2;
  check(
    'reversal after the lock expires does fire',
    run([
      ...armAt(),
      ...travel(5, SWIPE_DX + 0.06),
      ...rep(pause, { ext: OPEN, x: -(SWIPE_DX + 0.06) }),
      ...travel(5, -(SWIPE_DX + 0.06), OPEN, -(SWIPE_DX + 0.06)),
    ]),
    ['next', 'prev'],
  );
}

// An armed hand that STOPS still hands control back to the finger counts, without
// taking it out of frame. This is what the `moving` half of the pose test buys: the
// relaxed SWIPE_HOLD_FINGERS threshold applies only mid-sweep, so a stationary armed
// palm showing two fingers reads as a count, not as a swipe pose forever.
// The 26 frames are a LITERAL, comfortably past the grace window plus the dwell.
// Verified non-vacuous: with SWIPE_MERGE_GRACE_FRAMES = 9999 this returns [].
check(
  'armed but stationary hand still honours finger counts',
  run([...armAt(), ...rep(26, { ext: ['index', 'middle'] })]),
  ['open:2'],
);

// "less time between breaks of movement" — an ordinary pause between two swipes
// must NOT disarm the hand. 12 frames (~500 ms) is a normal beat between strokes;
// the second swipe has to land without a fresh still-hold. Literal count.
// Verified non-vacuous: with SWIPE_IDLE_DISARM_FRAMES = 8 this returns ['next'].
check(
  'a pause between swipes does not disarm',
  run([
    ...armAt(),
    ...travel(4, SWIPE_DX + 0.04),
    ...rep(12, { ext: OPEN, x: -(SWIPE_DX + 0.04) }),
    ...travel(4, SWIPE_DX + 0.04, OPEN, -(SWIPE_DX + 0.04)),
  ]),
  ['next', 'next'],
);

// "multiple tabs in one swipe if it is far enough" — a full-width sweep should
// advance several tabs, not one.
{
  const fired = run([...armAt(), ...travel(20, 0.85)]);
  const ok = fired.length >= 3 && fired.every((f) => f === 'next');
  try {
    assert.ok(ok, `expected >=3 consecutive 'next', got [${fired}]`);
    console.log(`  ok   long sweep advances several tabs -> [${fired}]`);
  } catch (err) {
    failed++;
    console.error(`  FAIL long sweep advances several tabs: ${err.message}`);
  }
}

// THE TUNING INVARIANT. "Still" must be slower than the slowest hand that can fire
// a swipe. Otherwise there's a band where a drifting hand counts as holding steady
// AND trips swipes — it would never disarm while quietly flipping tabs. This guards
// the relationship between three constants that are all meant to be hand-tuned.
{
  const slowestFiring = SWIPE_DX / (SWIPE_WINDOW_MS / 1000);
  try {
    assert.ok(
      SWIPE_STILL_SPEED < slowestFiring,
      `SWIPE_STILL_SPEED (${SWIPE_STILL_SPEED}) must stay below SWIPE_DX/SWIPE_WINDOW_MS (${slowestFiring.toFixed(3)} widths/s)`,
    );
    console.log(`  ok   still-speed invariant: ${SWIPE_STILL_SPEED} < ${slowestFiring.toFixed(3)} widths/s`);
  } catch (err) {
    failed++;
    console.error(`  FAIL still-speed invariant: ${err.message}`);
  }
}

// Cooldown: a second gesture immediately after a fire is swallowed.
check(
  'cooldown swallows an immediate second gesture',
  run([
    ...rep(DWELL_FRAMES, { ext: ['index'] }),
    ...rep(DWELL_FRAMES + 2, { ext: ['index','middle'] }),
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
  for (let i = 0; i < DWELL_FRAMES - 1; i++) feed(hand(['index']));
  feed(null); // hand leaves frame
  for (let i = 0; i < DWELL_FRAMES - 1; i++) feed(hand(['index']));
  check('hand leaving frame resets dwell', act.fired, []);
}

console.log(failed ? `\n${failed} case(s) failed` : '\ngesture self-check passed');
process.exit(failed ? 1 : 0);

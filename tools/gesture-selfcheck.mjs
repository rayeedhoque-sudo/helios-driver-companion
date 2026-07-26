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
  PINCH_ON,
  PINCH_OFF,
  PINCH_HOLD_FRAMES,
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
function hand(ext = [], marginal = null, pinched = false) {
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
  // Pinch. Reproduces BOTH measured pinch features, not just the obvious one:
  //   pinchRatio    = dist(4,8)/dist(0,9)  -> 0.151 (measured median)
  //   pinchVsMiddle = dist(4,8)/dist(4,12) -> 2.32  (measured median)
  // dist(0,9) is 0.10 here, so dist(4,8) must be 0.0151 and dist(4,12) 0.0065.
  // Those are closer together than the default fingertip spacing allows, so the
  // index and middle tips move too — which is what a real hand does, the fingers
  // come forward to meet the thumb. An earlier version only set the thumb and left
  // the fingers spread; it satisfied pinchRatio but not pinchVsMiddle, so it stopped
  // being a pinch the moment a second discriminator was added. Third time an
  // idealised hand has gone stale here; prefer the REAL fixtures below for new work.
  if (pinched) {
    lm[TIP.index] = P(0.47, 0.76);
    lm[4] = P(0.4849, 0.7625); // dist to index tip = 0.0151
    lm[TIP.middle] = P(0.4884, 0.768); // dist from thumb = 0.0065
  }
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
    focusNext: (side) => fired.push('next:' + side),
    focusPrev: (side) => fired.push('prev:' + side),
    pinchStart: (side) => fired.push('grab:' + side),
    pinchMove: () => {},
    pinchDrop: () => fired.push('drop'),
    pinchCancel: () => fired.push('cancel'),
  };
}

// Feed `frames` (each: {ext, x}) at 1/DETECT_HZ intervals. x shifts the whole hand
// horizontally to simulate travel; MediaPipe x is normalized and gestures.ts mirrors it.
function run(frames, startAt = 10_000, handLabel = 'Right') {
  const act = recorder();
  reset();
  let t = startAt;
  for (const f of frames) {
    const lm = hand(f.ext, null, f.pinch === true).map((p) => ({ ...p, x: p.x + (f.x ?? 0) }));
    classify({ landmarks: [lm], handedness: [[{ categoryName: handLabel, score: 0.98 }]] }, act, t);
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

// Open palm travelling right -> 'next:right'. `from` lets a stroke start where the last
// one ended, so return strokes can be modelled.
const travel = (n, total, ext = OPEN, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ ext, x: from - (total * i) / (n - 1) }));
// Still frames at x, long enough to arm.
const armAt = (x = 0) => rep(SWIPE_ARM_FRAMES, { ext: OPEN, x });

check('open palm swipe fires once', run([...armAt(), ...travel(5, SWIPE_DX + 0.06)]), ['next:right']);

// THE REGRESSION GUARD for the arming gate: a hand crossing the whole frame fast,
// with no preceding pose hold — an arm reaching past the laptop, a coach gesturing
// over it. It never holds still, so it never arms.
// Verified non-vacuous: with SWIPE_ARM_FRAMES = 0 this returns ['next:right'].
check('fast sweep with no pose hold does not fire', run(travel(5, 0.9)), []);

// A sustained open-palm crossing DOES now fire, and that is deliberate. Arming used
// to demand stillness, which meant a swipe that started before the hand settled was
// ignored entirely — the reported "already-moving hand isn't recognised". Allowing
// SWIPE_ARM_MOVING_FRAMES of a moving palm to arm buys that back, and the cost is
// exactly this case: an arm crossing the frame open-handed now reads as a swipe.
// Documented rather than silently dropped, so the regression is visible if it
// becomes a nuisance at an event. Restore the stillness-only rule to undo it.
check('sustained open-palm crossing now DOES fire (accepted trade-off)', run(travel(12, 0.9)), ['next:right', 'next:right']);

// THE REAL GESTURE, measured on camera 2026-07-25 and replayed at the app's own
// 24 Hz: a quick flick with NO still-hold, ~7 frames covering ~0.24 frame-widths.
// One stroke must land exactly one tab. Before the trail kept the frames spent
// arming, this fired NOTHING at 24 Hz — arming ate ~250 ms of a ~300 ms stroke and
// the remainder never reached SWIPE_DX. Two of the user's three real strokes were
// being dropped.
check('short quick flick with no still-hold fires exactly once', run(travel(7, 0.24)), ['next:right']);

// The brief version is still rejected: SWIPE_ARM_MOVING_FRAMES means a hand has to
// look like an open palm for a while, so a quick pass-through still does nothing.
// Verified non-vacuous: with SWIPE_ARM_MOVING_FRAMES = 1 this returns ['next:right'].
check('brief open-palm pass-through still does not fire', run(travel(5, 0.9)), []);

// ---- reported on camera 2026-07-25: swipes were slow, one-shot, and dropped out --
// Each case below is one of those complaints.

// "I should be able to swipe through multiple tabs with the same palm." One
// continuous sweep must keep advancing, not stop after the first tab.
{
  const fired = run([...armAt(), ...travel(24, 1.0)]);
  const ok = fired.length >= 2 && fired.every((f) => f === 'next:right');
  try {
    assert.ok(ok, `expected >=2 consecutive 'next:right', got [${fired}]`);
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
// Verified non-vacuous: with SWIPE_REVERSE_LOCK_MS = 0 this returns ['next:right','prev:right'].
check(
  'return stroke does not undo the swipe',
  run([...armAt(), ...travel(5, SWIPE_DX + 0.06), ...travel(10, -(SWIPE_DX + 0.06), OPEN, -(SWIPE_DX + 0.06))]),
  ['next:right'],
);

// "a slight sweep motion which overlaps fingers and doesnt make all 5 visible".
// Once armed, the count may collapse to 2 mid-sweep and the swipe must survive.
check(
  'swipe survives fingers merging mid-sweep',
  run([...armAt(), ...travel(5, SWIPE_DX + 0.06, ['index', 'middle'])]),
  ['next:right'],
);

// "i should be able to swipe fast while still getting recognized". A sweep over
// only SWIPE_MIN_SAMPLES frames must still register.
check('fast two-sample swipe registers', run([...armAt(), ...travel(2, SWIPE_DX + 0.06)]), ['next:right']);

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
    ['next:right', 'prev:right'],
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
// Verified non-vacuous: with SWIPE_IDLE_DISARM_FRAMES = 8 this returns ['next:right'].
check(
  'a pause between swipes does not disarm',
  run([
    ...armAt(),
    ...travel(4, SWIPE_DX + 0.04),
    ...rep(12, { ext: OPEN, x: -(SWIPE_DX + 0.04) }),
    ...travel(4, SWIPE_DX + 0.04, OPEN, -(SWIPE_DX + 0.04)),
  ]),
  ['next:right', 'next:right'],
);

// "multiple tabs in one swipe if it is far enough" — a full-width sweep should
// advance several tabs, not one.
{
  const fired = run([...armAt(), ...travel(20, 0.85)]);
  const ok = fired.length >= 3 && fired.every((f) => f === 'next:right');
  try {
    assert.ok(ok, `expected >=3 consecutive 'next:right', got [${fired}]`);
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

// ---- which half of a split dock a swipe drives -------------------------------
// From WHICH HAND, not from direction: left hand owns the left half, right hand the
// right half. Both directions are covered for both hands, because getting the side
// right for one direction and wrong for the other would still pass a narrower test.
console.log('\nhand -> side of a split dock:');

for (const [hand, dir, want] of [
  ['Right', +1, 'next:right'],
  ['Right', -1, 'prev:right'],
  ['Left', +1, 'next:left'],
  ['Left', -1, 'prev:left'],
]) {
  check(
    `${hand.toLowerCase()} hand swiping ${dir > 0 ? 'right' : 'left'} -> ${want}`,
    run([...armAt(), ...travel(5, dir * (SWIPE_DX + 0.06))], 10_000, hand),
    [want],
  );
}

// The side must not depend on travel direction — a hand keeps its own half whichever
// way it sweeps. Verified non-vacuous: deriving `side` from dx instead of handedness
// makes two of the four cases above fail.
check(
  'one hand sweeping both ways stays on its own side',
  run(
    [
      ...armAt(),
      ...travel(5, SWIPE_DX + 0.06),
      ...rep(20, { ext: OPEN, x: -(SWIPE_DX + 0.06) }),
      ...travel(5, -(SWIPE_DX + 0.06), OPEN, -(SWIPE_DX + 0.06)),
    ],
    10_000,
    'Left',
  ),
  ['next:left', 'prev:left'],
);

// ---- pinch: grab a tab, preview, drop ---------------------------------------
// A drop rearranges panels and rewrites the persisted layout, so these pin the two
// rules that keep it deliberate: only an opened palm drops, and losing the hand
// cancels instead.
console.log('\npinch -> drag a tab between halves:');

const PINCHED = { ext: [], pinch: true };
const dragFrames = (n, total) => travel(n, total, []).map((f) => ({ ...f, pinch: true }));

// A held pinch grabs from the hand's OWN side, once, after the brief hold.
check('pinch grabs from the right hand side', run(rep(PINCH_HOLD_FRAMES + 6, PINCHED), 10_000, 'Right'), [
  'grab:right',
]);
check('pinch grabs from the left hand side', run(rep(PINCH_HOLD_FRAMES + 6, PINCHED), 10_000, 'Left'), [
  'grab:left',
]);

// A pinch shape flashing past on the way to another pose must not grab anything.
// Frame count is a LITERAL, not PINCH_HOLD_FRAMES - 1: deriving it would scale the
// input with any mutation and the case could never fail.
// Verified non-vacuous: with PINCH_HOLD_FRAMES = 1 this returns ['grab:right'].
check('brief pinch does not grab', run(rep(2, PINCHED), 10_000, 'Right'), []);

// Grab, drag, then OPEN the palm -> exactly one drop.
check(
  'opening the palm drops once',
  run([...rep(PINCH_HOLD_FRAMES + 2, PINCHED), ...dragFrames(6, 0.4), ...rep(6, { ext: OPEN })], 10_000, 'Right'),
  ['grab:right', 'drop'],
);

// A drag must not leak into the swipe or finger-count paths. On real hands the
// finger count flickers 0-1 while pinching, and 1 is a live gesture.
check(
  'a long drag fires no swipe and no panel count',
  run([...rep(PINCH_HOLD_FRAMES + 2, PINCHED), ...dragFrames(30, 0.9)], 10_000, 'Right'),
  ['grab:right'],
);

// THE SAFETY RULE: losing the hand mid-drag CANCELS, it never drops. A drop
// rewrites the saved layout, so it must never happen because tracking blinked.
// Verified non-vacuous: calling pinchDrop() on hand-loss makes this return 'drop'.
{
  const act = recorder();
  reset();
  let t = 10_000;
  const feed = (lm) => {
    classify(
      { landmarks: lm ? [lm] : [], handedness: [[{ categoryName: 'Right', score: 0.98 }]] },
      act,
      t,
    );
    t += 1000 / DETECT_HZ;
  };
  for (let i = 0; i < PINCH_HOLD_FRAMES + 4; i++) feed(hand([], null, true));
  for (let i = 0; i < 4; i++) feed(null); // tracking drops out mid-drag
  check('losing the hand mid-drag cancels, never drops', act.fired, ['grab:right', 'cancel']);
}


// ---- real recorded poses -----------------------------------------------------
// Real landmark frames recorded on the driver laptop 2026-07-26, one
// representative (median pinch-ratio) frame per pose. Fixtures rather than
// synthetic hands because an idealised synthetic model has twice hidden a real
// bug in this suite — the thumb-extension test and the pinch/fist split.
// [x, y] pairs, MediaPipe landmark order 0..20.
const REAL = {
  PINCH: /* pinchRatio 0.151 */ [[0.3352,0.7901],[0.3753,0.7532],[0.4041,0.6928],[0.4125,0.6444],[0.4116,0.6],[0.3858,0.571],[0.4037,0.5351],[0.4254,0.5574],[0.4433,0.5879],[0.3568,0.5669],[0.3795,0.521],[0.4012,0.5527],[0.4164,0.5916],[0.3266,0.5828],[0.3448,0.5421],[0.3675,0.5761],[0.3842,0.6115],[0.2974,0.6184],[0.3219,0.6022],[0.3477,0.6196],[0.3692,0.6344]],
  FIST: /* pinchRatio 0.298 */ [[0.2124,0.945],[0.2515,0.9035],[0.2869,0.8269],[0.2762,0.7586],[0.2402,0.7329],[0.2817,0.7464],[0.2967,0.6993],[0.2851,0.7689],[0.2773,0.7834],[0.2479,0.738],[0.2593,0.6933],[0.2528,0.7734],[0.245,0.7791],[0.214,0.7447],[0.2224,0.7051],[0.2248,0.7802],[0.2177,0.7849],[0.1779,0.759],[0.1919,0.7289],[0.1974,0.7806],[0.1916,0.7906]],
  BENT_PALM: /* pinchRatio 0.891 */ [[0.2222,0.9534],[0.2761,0.9037],[0.3202,0.8352],[0.3542,0.788],[0.3889,0.7544],[0.2771,0.7099],[0.2948,0.6283],[0.3064,0.5836],[0.3223,0.5456],[0.2419,0.7081],[0.245,0.623],[0.2523,0.5784],[0.2677,0.5439],[0.2094,0.7296],[0.2071,0.6487],[0.2151,0.6072],[0.2321,0.5766],[0.1781,0.7683],[0.1746,0.7044],[0.1808,0.6647],[0.1946,0.6312]],
  TILTED_PALM: /* pinchRatio 0.972 */ [[0.2839,0.872],[0.3293,0.8191],[0.359,0.7437],[0.385,0.6919],[0.4124,0.6578],[0.3306,0.6247],[0.343,0.5316],[0.3561,0.4748],[0.3709,0.424],[0.3061,0.6287],[0.3105,0.5292],[0.3223,0.4639],[0.3358,0.4049],[0.2818,0.6574],[0.2793,0.5623],[0.2855,0.5044],[0.2945,0.4526],[0.2586,0.7033],[0.2518,0.6341],[0.2534,0.5842],[0.2574,0.5353]],
  FLAT_PALM: /* pinchRatio 1.173 */ [[0.2532,0.8783],[0.3078,0.8296],[0.3545,0.7666],[0.3929,0.7158],[0.4279,0.6912],[0.3037,0.6292],[0.3219,0.5261],[0.3325,0.4618],[0.3403,0.4036],[0.2664,0.6224],[0.2707,0.5059],[0.2728,0.4311],[0.2728,0.3684],[0.2322,0.6409],[0.2218,0.5378],[0.2142,0.4695],[0.2083,0.4114],[0.2002,0.6794],[0.1834,0.6062],[0.1723,0.5563],[0.1635,0.5082]],
};

// Turn a fixture into the landmark shape classify() expects, optionally shifted
// horizontally to simulate the hand travelling across the frame.
const real = (pose, dx = 0) => REAL[pose].map(([x, y]) => ({ x: x + dx, y, z: 0 }));

const drive = (frames) => {
  const act = recorder();
  reset();
  let t = 10_000;
  for (const lm of frames) {
    classify({ landmarks: [lm], handedness: [[{ categoryName: 'Right', score: 0.98 }]] }, act, t);
    t += 1000 / DETECT_HZ;
  }
  return act.fired;
};

console.log('\nreal recorded poses -> what the classifier does with them:');

// A FIST must not grab. It sat inside the old PINCH_ON and silently picked up a tab,
// after which the pinch branch returned early every frame and the palm that followed
// was never seen as a palm — the reported "can't recognise my palm when tilted or
// bent".
//
// Non-vacuous, but it takes BOTH mutations to show it: restoring PINCH_ON to 0.45
// AND dropping the pinchVsMiddle test makes this return ['grab:right']. Either guard
// alone still blocks a fist, which is the point — the two thresholds sit only 2-3%
// off the measured fist range individually, so a false grab needs both to drift at
// once. Do not "simplify" this back to a single condition.
check('a real FIST never grabs a tab', drive(Array.from({ length: 30 }, () => real('FIST'))), []);

// The other side of that threshold: tightening PINCH_ON to keep fists out must not
// lock real pinches out too.
check('a real PINCH still grabs', drive(Array.from({ length: 12 }, () => real('PINCH'))), ['grab:right']);

// The actual complaint: tilted and bent palms must still drive a swipe. Each is a
// real recorded frame stepped sideways to simulate the sweep. Mirrored x means a
// DECREASING raw x reads as moving to your right, so these expect 'next'.
// Asserted as "fires at least once, all in the right direction" rather than an exact
// count: the sweep here covers 0.28 frame-widths against SWIPE_DX 0.10, so several
// tabs legitimately advance. What matters is that a tilted or bent palm is seen as a
// palm at all, which is what regressed.
for (const pose of ['FLAT_PALM', 'TILTED_PALM', 'BENT_PALM']) {
  const fired = drive(Array.from({ length: 14 }, (_, i) => real(pose, -0.02 * i)));
  const ok = fired.length >= 1 && fired.every((f) => f === 'next:right');
  try {
    assert.ok(ok, `expected >=1 'next:right' and nothing else, got [${fired}]`);
    console.log(`  ok   a real ${pose} swipes -> [${fired}]`);
  } catch (err) {
    failed++;
    console.error(`  FAIL a real ${pose} swipes: ${err.message}`);
  }
}

console.log(failed ? `\n${failed} case(s) failed` : '\ngesture self-check passed');
process.exit(failed ? 1 : 0);

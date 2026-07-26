// Webcam hand-gesture panel navigation (opt-in, default OFF).
//
// MediaPipe HandLandmarker runs in the renderer over the laptop's webcam and gives
// 21 landmarks per hand; the gestures below are plain geometry on those points, not
// a trained classifier. Both the WASM runtime and the .task model are vendored into
// dist/ by build.mjs, so this works with no internet — the field has none.
//
// ============================ SAFETY (read before editing) ============================
// Gestures may ONLY call the actions passed in as `GestureActions`. They must NEVER
// synthesize a click, a key event, or any DOM activation. panels.ts has TEST MODE rows
// that command motors and deploy.ts deploys code to the robot — a false positive that
// changes which tab is focused is harmless, one that presses a button is not. That
// rule is absolute and is what keeps this feature safe to arm during a match.
//
// One action group is NOT read-only: pinch drag MOVES a panel between dock groups,
// and app.ts persists the layout ~400 ms after any change. A misread drop therefore
// rewrites the saved layout, and the only recovery is "Reset layout" in settings.
// Two mitigations, both load-bearing — do not remove them casually:
//   * a drop only ever happens on a deliberate palm-open (PINCH_OFF hysteresis);
//   * losing the hand mid-drag CANCELS, it never drops.
// Nothing here closes a panel, and no gesture can create or delete one.
// ======================================================================================
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

/**
 * Which half of a split dock a gesture addresses. Your LEFT hand drives the left
 * half, your right hand the right half, and neither can reach across — so in a
 * two-way split each hand owns its own side's tabs.
 */
export type DockSide = 'left' | 'right';

/**
 * The only things a gesture is allowed to do.
 *
 * Everything except the pinch group is focus-only. The pinch group DOES rearrange
 * panels, which is the one thing here that changes the persisted layout — see the
 * safety note at the top of the file.
 */
export interface GestureActions {
  /** Open/focus the Nth registry panel, 1-based. */
  openNth(n: number): void;
  focusNext(side: DockSide): void;
  focusPrev(side: DockSide): void;
  /** Pick up the active tab of `side`. No-op if that side has nothing to grab. */
  pinchStart(side: DockSide): void;
  /** Hand moved while pinching. `x`/`y` are 0..1 across the frame, x mirrored so 0 is YOUR left. */
  pinchMove(x: number, y: number): void;
  /** Palm opened — commit the move to wherever the preview is showing. */
  pinchDrop(): void;
  /** Hand lost or gesture abandoned — put everything back, change nothing. */
  pinchCancel(): void;
}

// ---- tuning knobs ------------------------------------------------------------
// Real cameras, real lighting, real hands — these are meant to be tuned on the
// actual driver laptop, not derived. Raise DWELL/COOLDOWN if you get false fires.
// 30, matching what the camera actually delivers — getCapabilities reports frameRate
// max 30, so asking for more only re-runs inference on repeated frames. Raised from
// 24 on 2026-07-26 to get ~25% more samples out of a hand that sweeps into frame and
// straight back out; a recorded entry lasts only 270-410 ms. Measured inference is
// p50 7.9 ms / p90 10.6 ms, against a 33 ms budget at 30 Hz.
const DETECT_HZ = 30; // inference rate; the DS + Limelight stream share this CPU
// Scaled with DETECT_HZ (12 -> 15) purely to PRESERVE the tuned ~0.5 s dwell. Left
// at 12 it would have become 400 ms and made the finger-count gestures twitchier,
// which nobody asked for.
const DWELL_FRAMES = 15; // consecutive stable frames before a finger-count fires (~0.5 s)
const COOLDOWN_MS = 900; // after a finger-count fire, so one gesture = one action
const MIN_CONFIDENCE = 0.6;

// --- swipe path ---
// SWIPE_DX and SWIPE_STILL_SPEED were rescaled by 0.75 on 2026-07-25 when the
// capture switched from a cropped 4:3 frame to the camera's full 16:9 one. Both are
// fractions of FRAME WIDTH, and the frame got wider, so the same physical hand
// movement now covers less of it — without rescaling, every swipe would have needed
// ~33% more reach than the values tuned by feel. The factor is measured, not
// assumed: template-matching the same scene at both settings put the old 4:3 frame
// at 74% of the 16:9 width (NCC 0.98) at 99% of its height — a clean side-crop.
// Rescale both together if the capture resolution ever changes again; they are tied
// by the invariant below.
//
// Speeds are per SECOND, not per frame, so retuning DETECT_HZ doesn't silently
// change how fast a hand has to move. Frame counts are the exception and scale
// with DETECT_HZ by design (they express "briefly", not "this fast").
const SWIPE_ARM_FRAMES = 2; // palm held STILL this long to arm (~83 ms at 24 Hz)
// ...or, for a palm that is ALREADY MOVING when it enters frame, this many frames of
// a clear open palm instead (~250 ms at 24 Hz). Requested 2026-07-25: a swipe that
// starts before the hand settles was being ignored entirely, because arming used to
// demand stillness and a hand already in motion never provided it.
//
// TRADE-OFF, deliberate: this is the guard that used to reject an arm crossing the
// frame — reaching past the laptop, a coach gesturing over it. Those now CAN fire a
// swipe. Raise this, or restore the stillness-only rule, if false swipes show up at
// an event. A brief pass-through is still rejected: it must look like an open palm
// for the whole window.
const SWIPE_ARM_MOVING_FRAMES = 6;
const SWIPE_ARM_FINGERS = 4; // clear open palm needed to ARM a swipe...
const SWIPE_HOLD_FINGERS = 2; // ...but only this many to KEEP one alive mid-sweep
const SWIPE_STILL_SPEED = 0.19; // frame-widths/sec still counted as "holding steady"
const SWIPE_DX = 0.1; // wrist travel that counts as one tab of swipe
const SWIPE_WINDOW_MS = 400; // ...within this long
const SWIPE_MIN_SAMPLES = 2; // samples needed to measure it — 2 so fast swipes register
const SWIPE_REPEAT_MS = 150; // between consecutive tabs of one continuous sweep
const SWIPE_REVERSE_LOCK_MS = 600; // after a fire, ignore the opposite direction this long
// How long the relaxed SWIPE_HOLD_FINGERS threshold survives after the hand stops
// moving. Needs to be > 0: the fingers merge as the sweep BEGINS, often a frame
// before the wrist speed registers, and a strict this-frame-only test drops the arm
// right at the start of the gesture. Once it lapses the strict count applies again,
// which is what hands control back to the 1-3 finger gestures (~330 ms at 24 Hz).
const SWIPE_MERGE_GRACE_FRAMES = 8;

// --- pinch path: drag a tab between the two halves ---------------------------
// Pinch measure is thumb tip (4) to index tip (8) over the palm's own size
// (wrist 0 to middle MCP 9), so it is scale-free — it does not care how close your
// hand is to the camera.
//
// Worth knowing: a pinch reads extendedCount 0, NOT 3 as the visible finger count
// suggests — so it does not collide with the 1-3 finger panel gestures. The pinch
// branch still runs before them and returns, because during a drag the count
// flickers between 0 and 1 and 1 is a real gesture.
//
// RETUNED 2026-07-26 after "the app can't see my palm when tilted or my fingers are
// bent". The palm test was never the problem — extendedCount reads >= 4 on 100% of
// tilted and bent frames. The real cause was this path stealing them: at PINCH_ON
// 0.45 a plain FIST (ratio 0.26-0.35) read as a pinch, silently grabbed a tab, and
// then returned early every frame, so the palm that followed was never seen as a
// palm. Opening the hand afterwards DROPPED the tab, moving a panel unasked.
//
// Measured, all on this camera: held pinch 0.02-0.44 (p50 0.15) | fist 0.26-0.35 |
// bent palm 0.76-1.13 | tilted palm 0.80-2.14 | flat palm 1.15-1.20.
//
// Pinch and fist OVERLAP on ratio alone, so one threshold cannot separate them with
// any margin (0.25 leaves 3%). Starting a grab therefore needs BOTH tests, and a
// fist fails both — it would take two independent drifts to false-trigger:
//   ratio     < PINCH_ON          fist min 0.258 vs 0.25   (3.4% margin)
//   indexReach > PINCH_INDEX_REACH fist max 0.853 vs 0.88  (3.0% margin)
//
// indexReach is the index TIP's distance from the wrist over the palm's own size.
// In a pinch the index reaches forward to meet the thumb (0.79-1.25, p50 1.00); in a
// fist it is curled back against the palm (0.79-0.85); on an open palm it is far out
// (1.40-2.15). Measured on this camera.
//
// The first attempt used thumb-to-index over thumb-to-MIDDLE instead, which is a
// ratio of two distances that are BOTH near zero during a pinch — numerically
// unstable, and it rejected a third of real pinch frames, which is what "the pinch
// recognition got worse" was. indexReach divides by the palm span instead, so both
// terms stay well-conditioned: 97.2% of held-pinch frames now qualify, against 67.5%
// before, with the fist still blocked twice over.
const PINCH_ON = 0.25; // thumb-index over palm span, below this = pinching
const PINCH_INDEX_REACH = 0.88; // ...and the index must be REACHING, not curled into a fist
const PINCH_OFF = 0.6; // release. Above held-pinch max 0.44, below palm min 0.76.
const PINCH_HOLD_FRAMES = 3; // frames before a pinch counts as a deliberate grab

// INVARIANT (pinned by tools/gesture-selfcheck.mjs): SWIPE_STILL_SPEED must stay
// below SWIPE_DX / SWIPE_WINDOW_MS — the slowest hand that can still fire a swipe.
// If "still" were the faster of the two there'd be a band where a slow drift counts
// as holding steady AND trips a swipe, so the hand would never disarm while quietly
// flipping tabs. Retune any of the three and keep this ordering.

// How far past its middle joint a finger must reach to count as extended. Raise if
// half-curled fingers register; lower if fully-extended ones are missed.
const FINGER_MARGIN = 1.08;
// Same idea for the thumb's sideways test. Separate knob because it's a different
// measurement (see extendedCount) and wants tuning independently.
const THUMB_MARGIN = 1.05;

// ---- geometry ----------------------------------------------------------------
type Pt = { x: number; y: number; z: number };

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// A finger is "extended" when its tip sits further from the wrist than its middle
// joint does. Crude but orientation-independent, which matters because the driver
// laptop sits at whatever angle it sits at.
//
// The thumb needs a different test and must NOT be added to the list below. It does
// not curl toward the wrist like the fingers — it folds ACROSS the palm, so even in
// a closed fist the thumb tip stays further from the wrist than its own base joint.
// Under the radial test it therefore reads "extended" in every pose, which counted
// every gesture one too high (a fist opened panel 1; thumb-tucked-index-out opened
// panel 2). Measured on-camera 2026-07-25. Judge it sideways instead: an extended
// thumb points away from the pinky, a tucked one lies across the palm toward it.
function extendedCount(lm: Pt[]): number {
  const wrist = lm[0];
  const pairs: [number, number][] = [
    [8, 6], // index
    [12, 10], // middle
    [16, 14], // ring
    [20, 18], // pinky
  ];
  let n = 0;
  for (const [tip, joint] of pairs) {
    if (dist(lm[tip], wrist) > dist(lm[joint], wrist) * FINGER_MARGIN) n++;
  }
  // Thumb: tip (4) vs its own IP joint (3), both measured against the pinky MCP (17).
  if (dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * THUMB_MARGIN) n++;
  return n;
}

// Scale-free pinch measure: thumb tip to index tip, over the palm's own size.
function pinchRatio(lm: Pt[]): number {
  const span = dist(lm[0], lm[9]);
  return span > 0 ? dist(lm[4], lm[8]) / span : Infinity;
}

// Is the index finger REACHING forward, or curled into a fist? Index tip's distance
// from the wrist over the palm's own size. This is what keeps a fist out of the
// pinch path — see PINCH_ON. Both terms are palm-scale, so unlike a thumb-to-index
// over thumb-to-middle ratio it stays well-conditioned when the fingertips bunch up.
function pinchIndexReach(lm: Pt[]): number {
  const span = dist(lm[0], lm[9]);
  return span > 0 ? dist(lm[0], lm[8]) / span : 0;
}

// ---- runtime -----------------------------------------------------------------
let landmarker: HandLandmarker | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let timer: number | undefined;
let running = false;

let lastFireAt = 0;
let stableCount = 0;
let stableFingers = -1;
let palmFrames = 0; // consecutive open-palm frames, moving or not
let palmStillFrames = 0; // ...of which consecutive STILL ones
let lastX = 0; // previous wrist x, for the per-frame speed test
let lastT = 0; // ...and its timestamp, so speed is per-second not per-frame
let hasLast = false; // whether lastX/lastT hold a real previous sample
let stillFrames = 0; // consecutive frames the hand has not been moving
let lastDir = 0; // direction of the last swipe, for the reverse lock
type Sample = { x: number; t: number };
let trail: Sample[] = [];
let pinching = false; // a grab is in progress
let pinchFrames = 0; // consecutive frames the hand has looked pinched

let onStatus: (text: string, kind: 'idle' | 'live' | 'error') => void = () => {};

// Load the model once. Paths are dist-relative (build.mjs puts them there).
async function ensureLandmarker(): Promise<HandLandmarker> {
  if (landmarker) return landmarker;
  const fileset = await FilesetResolver.forVisionTasks('mediapipe');
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: 'assets/hand_landmarker.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: MIN_CONFIDENCE,
    minHandPresenceConfidence: MIN_CONFIDENCE,
    minTrackingConfidence: MIN_CONFIDENCE,
  });
  return landmarker;
}

// Decide what (if anything) the current frame means, and fire at most one action.
function classify(res: HandLandmarkerResult, actions: GestureActions, now: number): void {
  const hand = res.landmarks?.[0] as Pt[] | undefined;
  if (!hand || hand.length < 21) {
    // Losing the hand mid-drag CANCELS rather than drops. A drop rearranges the
    // persisted layout, so it must be something you did on purpose, never something
    // that happened because tracking blinked.
    if (pinching) {
      pinching = false;
      actions.pinchCancel();
      onStatus('grab cancelled', 'idle');
    }
    pinchFrames = 0;
    stableCount = 0;
    stableFingers = -1;
    palmFrames = palmStillFrames = 0;
    hasLast = false;
    stillFrames = 0;
    lastDir = 0;
    trail = [];
    return;
  }

  const fingers = extendedCount(hand);
  const x = 1 - hand[0].x; // mirrored, so hand-moves-right reads as "next"
  // Armed either by a brief still hold, or — for a hand already in motion when it
  // arrives — by simply looking like an open palm for longer. See the constants.
  const armed = palmStillFrames >= SWIPE_ARM_FRAMES || palmFrames >= SWIPE_ARM_MOVING_FRAMES;

  // Wrist speed since the previous frame, per second so DETECT_HZ can be retuned
  // freely. Tracked for EVERY frame with a hand in it, not just palm frames, so the
  // pose test below can ask "is this hand moving?" before deciding what it is.
  const dt = Math.max(now - lastT, 1) / 1000;
  // No previous sample means no motion has been OBSERVED yet, so report 0 rather
  // than Infinity. Reporting Infinity made the first frame of every appearance count
  // as "moving", which silently cost one frame of every still-hold and pushed arming
  // past SWIPE_ARM_FRAMES.
  const speed = hasLast ? Math.abs(x - lastX) / dt : 0;
  lastX = x;
  lastT = now;
  hasLast = true;
  const moving = speed > SWIPE_STILL_SPEED;
  stillFrames = moving ? 0 : stillFrames + 1;
  const recentlyMoving = stillFrames <= SWIPE_MERGE_GRACE_FRAMES;

  // --- pinch: grab the active tab, drag it, open the palm to drop --------------
  // Runs FIRST and returns, so a drag can never leak into the swipe or finger-count
  // paths. That matters: while dragging, extendedCount flickers between 0 and 1, and
  // 1 is a real gesture (open Limelight).
  const pinch = pinchRatio(hand);
  if (pinching) {
    // Hysteresis: only a clearly open hand ends the drag, so the grip can loosen
    // mid-drag without dropping the tab somewhere unintended.
    if (pinch > PINCH_OFF) {
      pinching = false;
      pinchFrames = 0;
      actions.pinchDrop();
      onStatus('dropped', 'live');
      lastFireAt = now;
    } else {
      actions.pinchMove(x, hand[0].y);
    }
    stableCount = 0;
    stableFingers = -1;
    palmFrames = palmStillFrames = 0;
    trail = [];
    return;
  }

  if (pinch < PINCH_ON && pinchIndexReach(hand) > PINCH_INDEX_REACH) {
    // Brief hold before committing, so a hand passing through a pinch-like shape on
    // its way to some other pose doesn't grab a tab.
    pinchFrames++;
    if (pinchFrames >= PINCH_HOLD_FRAMES) {
      pinching = true;
      // The hand that grabs decides whose tab it is — same rule as the swipe.
      const grabSide: DockSide = res.handedness?.[0]?.[0]?.categoryName === 'Left' ? 'left' : 'right';
      actions.pinchStart(grabSide);
      onStatus(`grabbed ${grabSide}`, 'live');
    }
    stableCount = 0;
    stableFingers = -1;
    palmFrames = palmStillFrames = 0;
    trail = [];
    return;
  }
  pinchFrames = 0;


  // --- open-palm swipe -> cycle focus ---
  // Arming demands a clear open palm. Once armed AND MOVING, a much lower count
  // keeps the swipe alive: in a real sweep the fingers rotate, overlap and merge and
  // MediaPipe stops resolving all five, which is what made fast natural swipes drop
  // out mid-motion. The `moving` half matters — relaxing the count for a STATIONARY
  // armed hand would swallow the 2- and 3-finger gestures, since an armed palm
  // showing two fingers would read as a swipe pose forever.
  if (fingers >= (armed && recentlyMoving ? SWIPE_HOLD_FINGERS : SWIPE_ARM_FINGERS)) {
    // An open palm is the swipe pose, never a finger-count pose.
    stableCount = 0;
    stableFingers = -1;

    // Track the wrist from the FIRST palm frame, including the ones spent arming.
    // Arming takes SWIPE_ARM_MOVING_FRAMES (~250 ms), and a quick flick is only
    // ~300 ms long — discarding the travel that happened while arming threw away
    // most of the stroke and the swipe never reached SWIPE_DX. The arming window is
    // part of the gesture, so it belongs in the trail; SWIPE_WINDOW_MS still ages
    // stale samples out, and a hand that pauses first simply contributes stationary
    // samples that cancel.
    trail.push({ x, t: now });
    trail = trail.filter((s) => now - s.t <= SWIPE_WINDOW_MS);

    // Two ways in: a short STILL hold (deliberate, and the stricter of the two), or
    // a longer run of open-palm frames for a hand that is already moving.
    if (!armed) {
      palmFrames++;
      palmStillFrames = moving ? 0 : palmStillFrames + 1;
      return;
    }

    if (now - lastFireAt < SWIPE_REPEAT_MS || trail.length < SWIPE_MIN_SAMPLES) return;

    const dx = trail[trail.length - 1].x - trail[0].x;
    if (Math.abs(dx) < SWIPE_DX) return;
    const dir = dx > 0 ? 1 : -1;
    // Ignore the return stroke. Swiping repeatedly means bringing your hand back,
    // and that return is itself a qualifying sweep in the opposite direction — it
    // would undo the swipe you just made. Briefly lock out the reverse instead of
    // demanding you leave the frame and start over.
    if (dir === -lastDir && now - lastFireAt < SWIPE_REVERSE_LOCK_MS) {
      trail = [];
      return;
    }
    // Which half of a split dock this swipe drives, from WHICH HAND is doing it:
    // left hand -> left half, right hand -> right half, never across. MediaPipe's
    // handedness label is used as-is — verified on this camera 2026-07-25, a right
    // hand moving left reported "Right" and a left hand moving right reported
    // "Left". Do NOT invert it without re-measuring; a flipped label silently swaps
    // which side of the screen each hand drives.
    const side: DockSide = res.handedness?.[0]?.[0]?.categoryName === 'Left' ? 'left' : 'right';
    if (dir > 0) actions.focusNext(side);
    else actions.focusPrev(side);
    onStatus(`${side}: ${dir > 0 ? 'next' : 'previous'}`, 'live');
    lastFireAt = now;
    lastDir = dir;
    // Stay armed: a continuous sweep keeps advancing tabs, no re-pause needed.
    trail = [];
    return;
  }

  palmFrames = palmStillFrames = 0;
  lastDir = 0;
  trail = [];

  if (now - lastFireAt < COOLDOWN_MS) return;

  // --- N fingers held still -> open the Nth panel ---
  if (fingers >= 1 && fingers <= 3) {
    if (fingers === stableFingers) stableCount++;
    else {
      stableFingers = fingers;
      stableCount = 1;
    }
    if (stableCount >= DWELL_FRAMES) {
      actions.openNth(fingers);
      onStatus(`panel ${fingers}`, 'live');
      lastFireAt = now;
      stableCount = 0;
      stableFingers = -1;
    }
    return;
  }

  stableCount = 0;
  stableFingers = -1;
}

function tick(actions: GestureActions): void {
  if (!running || !landmarker || !video) return;
  // performance.now() is the clock MediaPipe's VIDEO mode wants (monotonic ms).
  const now = performance.now();
  if (video.readyState >= 2) {
    try {
      classify(landmarker.detectForVideo(video, now), actions, now);
    } catch (err) {
      console.error('[gestures] detect failed:', err);
    }
  }
  timer = window.setTimeout(() => tick(actions), 1000 / DETECT_HZ);
}

/** Turn gesture control on. Resolves once the camera + model are live. */
export async function startGestures(actions: GestureActions, preview: HTMLVideoElement): Promise<void> {
  if (running) return;
  onStatus('starting...', 'idle');
  // Ask for the camera's full 16:9 frame. Requesting 640x480 got a 4:3 stream that
  // is a horizontal CROP of the sensor, not a squeeze — measured 2026-07-25 by
  // capturing the same scene at both settings: objects at the left and right edges
  // of the 1280x720 frame are simply absent from the 640x480 one. That threw away
  // ~25% of the width, which is the room a sideways swipe needs, and is very likely
  // why the hand kept leaving frame.
  //
  // Costs almost nothing: MediaPipe downscales to its own model input before
  // inference, so measured p50 was 7.9 ms at 720p vs 8.2 ms at 480p (p90 10.6 vs
  // 9.9) — about a quarter of the 41.7 ms budget at DETECT_HZ 24.
  //
  // `ideal` rather than exact, so a camera without 720p degrades instead of failing.
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video = preview;
  video.srcObject = stream;
  await video.play();
  await ensureLandmarker();
  running = true;
  lastFireAt = performance.now(); // don't fire on whatever the hand was doing at startup
  onStatus('watching', 'live');
  tick(actions);
}

/** Turn gesture control off and release the camera (the LED must go out). */
export function stopGestures(): void {
  running = false;
  pinching = false;
  pinchFrames = 0;
  window.clearTimeout(timer);
  timer = undefined;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  stableCount = 0;
  stableFingers = -1;
  trail = [];
  onStatus('off', 'idle');
}

export function isRunning(): boolean {
  return running;
}

export function onGestureStatus(cb: (text: string, kind: 'idle' | 'live' | 'error') => void): void {
  onStatus = cb;
}

// Exported for the self-check in tools/gesture-selfcheck.mjs. `reset` clears the
// module-level dwell/cooldown state so each test case starts from a known point.
export const __test = {
  extendedCount,
  dist,
  classify,
  reset(): void {
    lastFireAt = 0;
    stableCount = 0;
    stableFingers = -1;
    palmFrames = palmStillFrames = 0;
    hasLast = false;
    stillFrames = 0;
    lastDir = 0;
    lastX = 0;
    lastT = 0;
    trail = [];
    pinching = false;
    pinchFrames = 0;
  },
  DETECT_HZ,
  DWELL_FRAMES,
  COOLDOWN_MS,
  SWIPE_ARM_FRAMES,
  SWIPE_DX,
  SWIPE_WINDOW_MS,
  SWIPE_STILL_SPEED,
  SWIPE_REPEAT_MS,
  SWIPE_REVERSE_LOCK_MS,
  SWIPE_MERGE_GRACE_FRAMES,
  PINCH_ON,
  PINCH_INDEX_REACH,
  PINCH_OFF,
  PINCH_HOLD_FRAMES,
  pinchRatio,
  pinchIndexReach,
};

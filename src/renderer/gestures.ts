// Webcam hand-gesture panel navigation (opt-in, default OFF).
//
// MediaPipe HandLandmarker runs in the renderer over the laptop's webcam and gives
// 21 landmarks per hand; the gestures below are plain geometry on those points, not
// a trained classifier. Both the WASM runtime and the .task model are vendored into
// dist/ by build.mjs, so this works with no internet — the field has none.
//
// ============================ SAFETY (read before editing) ============================
// Gestures may ONLY call the three focus actions passed in as `GestureActions`:
// openPanel / focusNext / focusPrev. They must NEVER synthesize a click, a key event,
// or any DOM activation. panels.ts has TEST MODE rows that command motors and deploy.ts
// deploys code to the robot — a false positive that changes which tab is focused is
// harmless, one that presses a button is not. Nothing here moves or closes a panel
// either, so a misread can't churn the layout blob app.ts persists.
// ======================================================================================
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

/** The only things a gesture is allowed to do. Deliberately focus-only — see header. */
export interface GestureActions {
  /** Open/focus the Nth registry panel, 1-based. */
  openNth(n: number): void;
  focusNext(): void;
  focusPrev(): void;
}

// ---- tuning knobs ------------------------------------------------------------
// Real cameras, real lighting, real hands — these are meant to be tuned on the
// actual driver laptop, not derived. Raise DWELL/COOLDOWN if you get false fires.
const DETECT_HZ = 24; // inference rate; the DS + Limelight stream share this CPU
const DWELL_FRAMES = 12; // consecutive stable frames before a finger-count fires (~0.5 s)
const COOLDOWN_MS = 900; // after a finger-count fire, so one gesture = one action
const MIN_CONFIDENCE = 0.6;

// --- swipe path ---
// Speeds are per SECOND, not per frame, so retuning DETECT_HZ doesn't silently
// change how fast a hand has to move. Frame counts are the exception and scale
// with DETECT_HZ by design (they express "briefly", not "this fast").
const SWIPE_ARM_FRAMES = 2; // palm held still this long to arm (~83 ms at 24 Hz)
const SWIPE_ARM_FINGERS = 4; // clear open palm needed to ARM a swipe...
const SWIPE_HOLD_FINGERS = 2; // ...but only this many to KEEP one alive mid-sweep
const SWIPE_STILL_SPEED = 0.25; // frame-widths/sec still counted as "holding steady"
const SWIPE_DX = 0.13; // wrist travel that counts as one tab of swipe
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

// ---- runtime -----------------------------------------------------------------
let landmarker: HandLandmarker | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let timer: number | undefined;
let running = false;

let lastFireAt = 0;
let stableCount = 0;
let stableFingers = -1;
let palmFrames = 0;
let lastX = 0; // previous wrist x, for the per-frame speed test
let lastT = 0; // ...and its timestamp, so speed is per-second not per-frame
let hasLast = false; // whether lastX/lastT hold a real previous sample
let stillFrames = 0; // consecutive frames the hand has not been moving
let lastDir = 0; // direction of the last swipe, for the reverse lock
type Sample = { x: number; t: number };
let trail: Sample[] = [];

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
    stableCount = 0;
    stableFingers = -1;
    palmFrames = 0;
    hasLast = false;
    stillFrames = 0;
    lastDir = 0;
    trail = [];
    return;
  }

  const fingers = extendedCount(hand);
  const x = 1 - hand[0].x; // mirrored, so hand-moves-right reads as "next"
  const armed = palmFrames >= SWIPE_ARM_FRAMES;

  // Wrist speed since the previous frame, per second so DETECT_HZ can be retuned
  // freely. Tracked for EVERY frame with a hand in it, not just palm frames, so the
  // pose test below can ask "is this hand moving?" before deciding what it is.
  const dt = Math.max(now - lastT, 1) / 1000;
  const speed = hasLast ? Math.abs(x - lastX) / dt : Infinity;
  lastX = x;
  lastT = now;
  hasLast = true;
  const moving = speed > SWIPE_STILL_SPEED;
  stillFrames = moving ? 0 : stillFrames + 1;
  const recentlyMoving = stillFrames <= SWIPE_MERGE_GRACE_FRAMES;

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

    // Arm on a palm held STILL. Presence alone does not work — an arm crossing the
    // frame (reaching past the laptop, a coach gesturing over it) stays open-handed
    // the whole way and would accumulate enough trail to fire. Pausing first is what
    // separates "swiped on purpose" from "passed through".
    if (!armed) {
      palmFrames = moving ? 1 : palmFrames + 1;
      trail = [];
      return;
    }

    trail.push({ x, t: now });
    trail = trail.filter((s) => now - s.t <= SWIPE_WINDOW_MS);
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
    if (dir > 0) actions.focusNext();
    else actions.focusPrev();
    onStatus(dir > 0 ? 'next panel' : 'previous panel', 'live');
    lastFireAt = now;
    lastDir = dir;
    // Stay armed: a continuous sweep keeps advancing tabs, no re-pause needed.
    trail = [];
    return;
  }

  palmFrames = 0;
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
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
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
    palmFrames = 0;
    hasLast = false;
    stillFrames = 0;
    lastDir = 0;
    lastX = 0;
    lastT = 0;
    trail = [];
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
};

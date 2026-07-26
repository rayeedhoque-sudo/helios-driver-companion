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
const DETECT_HZ = 12; // inference rate; the DS + Limelight stream share this CPU
const DWELL_FRAMES = 6; // consecutive stable frames before a finger-count fires (~0.5 s)
const COOLDOWN_MS = 900; // ignore everything right after a fire, so one gesture = one action
const SWIPE_DX = 0.22; // normalized wrist travel across the frame that counts as a swipe
const SWIPE_WINDOW_MS = 600; // ...within this long
const MIN_CONFIDENCE = 0.6;

// ---- geometry ----------------------------------------------------------------
type Pt = { x: number; y: number; z: number };

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// A finger is "extended" when its tip sits further from the wrist than its middle
// joint does. Crude but orientation-independent, which matters because the driver
// laptop sits at whatever angle it sits at.
function extendedCount(lm: Pt[]): number {
  const wrist = lm[0];
  const pairs: [number, number][] = [
    [4, 2], // thumb
    [8, 6], // index
    [12, 10], // middle
    [16, 14], // ring
    [20, 18], // pinky
  ];
  let n = 0;
  for (const [tip, joint] of pairs) {
    if (dist(lm[tip], wrist) > dist(lm[joint], wrist) * 1.08) n++;
  }
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
  if (now - lastFireAt < COOLDOWN_MS) return;

  const hand = res.landmarks?.[0] as Pt[] | undefined;
  if (!hand || hand.length < 21) {
    stableCount = 0;
    stableFingers = -1;
    trail = [];
    return;
  }

  const fingers = extendedCount(hand);

  // --- open-palm swipe -> cycle focus ---
  // Mirrored so it reads naturally: hand moves right on screen = "next".
  if (fingers >= 4) {
    const x = 1 - hand[0].x;
    trail.push({ x, t: now });
    trail = trail.filter((s) => now - s.t <= SWIPE_WINDOW_MS);
    if (trail.length >= 3) {
      const dx = trail[trail.length - 1].x - trail[0].x;
      if (Math.abs(dx) >= SWIPE_DX) {
        if (dx > 0) actions.focusNext();
        else actions.focusPrev();
        onStatus(dx > 0 ? 'next panel' : 'previous panel', 'live');
        lastFireAt = now;
        trail = [];
        stableCount = 0;
      }
    }
    // An open palm is the swipe pose, never a finger-count pose.
    stableCount = 0;
    stableFingers = -1;
    return;
  }

  trail = [];

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

// Exported for the self-check in tools/gesture-selfcheck.mjs.
export const __test = { extendedCount, dist };

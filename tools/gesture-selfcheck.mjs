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
const { extendedCount } = mod.__test;

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

console.log(failed ? `\n${failed} case(s) failed` : '\ngesture self-check passed');
process.exit(failed ? 1 : 0);

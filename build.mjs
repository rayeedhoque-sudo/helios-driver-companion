// Build: esbuild bundles the three entry points and copies static assets into dist/.
// Frozen for M0 — later milestones fill module internals, not this file.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });

const nodeCommon = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // electron + koffi stay external (native / provided by the runtime).
  external: ['electron', 'koffi'],
};

// Main process -> dist/main.cjs
await esbuild.build({
  ...nodeCommon,
  entryPoints: [path.join(root, 'src/main/main.ts')],
  outfile: path.join(dist, 'main.cjs'),
});

// Preload -> dist/preload.cjs
await esbuild.build({
  ...nodeCommon,
  entryPoints: [path.join(root, 'src/main/preload.ts')],
  outfile: path.join(dist, 'preload.cjs'),
});

// Diagnostics capture CLI -> dist/nt-diag.cjs (terminal tool, not part of the app)
await esbuild.build({
  ...nodeCommon,
  entryPoints: [path.join(root, 'tools/nt-diag.ts')],
  outfile: path.join(dist, 'nt-diag.cjs'),
});

// Renderer -> dist/renderer.js (browser IIFE, bundles uplot + ntcore-ts-client)
await esbuild.build({
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  // Emit non-ASCII (panel titles like "Limelight · Knight") as \u escapes so the
  // bundle can never mojibake regardless of the document's declared/actual charset.
  charset: 'ascii',
  entryPoints: [path.join(root, 'src/renderer/app.ts')],
  outfile: path.join(dist, 'renderer.js'),
});

// Static files
cpSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'index.html'));
cpSync(path.join(root, 'src/renderer/style.css'), path.join(dist, 'style.css'));
// Vendored dockview stylesheet (loaded before style.css so our theme overrides win).
// Copied rather than hand-inlined like uPlot's — it's 3.4k lines and tracks the package.
cpSync(
  path.join(root, 'node_modules/dockview-core/dist/styles/dockview.css'),
  path.join(dist, 'dockview.css'),
);
cpSync(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });

console.log('build complete -> dist/');

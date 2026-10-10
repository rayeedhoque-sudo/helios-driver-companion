// Path Planner panel: the BLine Web path editor in an iframe. The editor is a vendored local
// build (vendor/bline-web -> dist/bline-web, see build.mjs) so it works with no internet at
// events. It autosaves to its own localStorage; Project > Import / Export > "Import/Export Autos
// Folder..." reads and writes the robot repo's deploy/autos folder through the native picker.

export function mountPathPlanner(container: HTMLElement): void {
  injectStyles();
  container.replaceChildren();

  const root = document.createElement('div');
  root.className = 'pp-root';

  const hint = document.createElement('div');
  hint.className = 'pp-hint';
  hint.textContent =
    'Project › Import / Export › Import/Export Autos Folder: Helios-2026/src/main/deploy/autos' +
    '  ·  keep config.json at 3 m/s, 3 m/s² ' +
    '(BLinePathTest fails the build otherwise)  ·  paths are blue-origin field coordinates';

  const frame = document.createElement('iframe');
  frame.className = 'pp-frame';
  frame.src = 'bline-web/index.html';

  root.append(hint, frame);
  container.append(root);
}

// ---- one-time style injection (self-contained, same pattern as shooter.ts) ----
function injectStyles(): void {
  if (document.getElementById('pp-styles')) return;
  const style = document.createElement('style');
  style.id = 'pp-styles';
  style.textContent = [
    '.pp-root { display:flex; flex-direction:column; height:100%; box-sizing:border-box; }',
    '.pp-hint { flex:none; padding:6px 10px; font-size:12px; color:var(--text-dim,#a99cbe);',
    '  background:var(--surface-2,#100b17); border-bottom:1px solid var(--line-soft,#1d1528); }',
    '.pp-frame { flex:1; width:100%; border:0; background:#0b0812; }',
  ].join('\n');
  document.head.append(style);
}

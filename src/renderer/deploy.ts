// Deploy panel: drives `window.companion.deploy` (see ARCHITECTURE.md "Deploy
// (main) + IPC") to run `gradlew deploy` for the robot project and stream its
// output live. Panel-registry contract: mount(container) may be called more
// than once (reopen from "+ Panels"), so DOM + one-shot IPC subscriptions
// follow the same split used elsewhere (panels.ts ensure*Subs): the log
// buffer and run status live in MODULE scope so they survive a panel
// close/reopen mid-run; mount() just rebuilds the DOM and re-renders them.
import type { DeployStatus, DeployTarget } from '../main/preload';

const MAX_LOG_LINES = 2000;

// Project selector. Labels + paths are display-only; the actual deploy path is
// resolved from the KEY inside main/deploy.ts (PROJECT_DIRS) — the renderer only
// ever sends the key. V1 is the only project since the V2 tree was deleted.
const TARGETS: { key: DeployTarget; label: string; path: string }[] = [
  { key: 'v1', label: 'V1 — Helios-2026 (proven)', path: 'C:\\FRC\\Helios-2026' },
];
let selectedTarget: DeployTarget = 'v1';
function targetPath(key: DeployTarget): string {
  return TARGETS.find((t) => t.key === key)?.path ?? TARGETS[0].path;
}

// The project the PID panel bakes tuned gains into — always the one this dropdown would
// deploy, so "Save to Constants" always targets the project you are actually running.
export function currentDeployTarget(): DeployTarget {
  return selectedTarget;
}
export function currentDeployPath(): string {
  return targetPath(selectedTarget);
}

// ---- module-scope state (persists across mount/unmount) --------------------
const logBuffer: string[] = [];
let partialLine = ''; // trailing, not-yet-newline-terminated tail between output events
let status: DeployStatus = { phase: 'idle', startedAt: null, exitCode: null };
let tickTimer: number | null = null;

// current DOM refs — reassigned on every mount(); may go stale/detached if the
// panel is closed (harmless: writes to a detached node just don't paint).
let btnEl: HTMLButtonElement | null = null;
let cancelEl: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;
let logEl: HTMLElement | null = null;
let selectEl: HTMLSelectElement | null = null;
let captionEl: HTMLElement | null = null;

export function mountDeploy(container: HTMLElement): void {
  injectStyles();
  build(container);
  ensureSubs();
  void refreshStatus(); // pull authoritative state now (a run may already be in progress)
}

// ---- one-time style injection (self-contained — do not touch style.css) ----
function injectStyles(): void {
  if (document.getElementById('dpl-styles')) return;
  const style = document.createElement('style');
  style.id = 'dpl-styles';
  style.textContent = `
.dpl-root { display:flex; flex-direction:column; gap:12px; height:100%; box-sizing:border-box;
  padding:14px; font-family:var(--font-body,"Segoe UI",system-ui,sans-serif); color:var(--text,#f2eef8); }
.dpl-row { display:flex; align-items:center; gap:10px; }
.dpl-btn { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:13px; font-weight:700;
  letter-spacing:1px; text-transform:uppercase; color:#17102a; background:var(--accent,#b57bff);
  border:1px solid var(--accent,#b57bff); border-radius:6px; padding:10px 20px; cursor:pointer; }
.dpl-btn:hover:not(:disabled) { background:#c99cff; }
.dpl-btn:disabled { opacity:0.45; cursor:not-allowed; }
.dpl-cancel { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px; letter-spacing:1px;
  text-transform:uppercase; color:var(--text-dim,#a99cbe); background:var(--surface,#17111f);
  border:1px solid var(--line,#38294c); border-radius:6px; padding:9px 16px; cursor:pointer; }
.dpl-cancel:hover { color:var(--text,#f2eef8); border-color:var(--bad,#ff4d5e); }
.dpl-cancel[hidden] { display:none; }
.dpl-select { font-family:var(--font-body,"Segoe UI",system-ui,sans-serif); font-size:12px;
  color:var(--text,#f2eef8); background:var(--surface,#17111f); border:1px solid var(--line,#38294c);
  border-radius:6px; padding:9px 12px; cursor:pointer; }
.dpl-select:disabled { opacity:0.45; cursor:not-allowed; }
.dpl-select-label { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;
  color:var(--text-faint,#6c6182); }
.dpl-caption { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;
  color:var(--text-faint,#6c6182); }
.dpl-status { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:13px; letter-spacing:1px;
  text-transform:uppercase; padding:6px 10px; border-radius:6px; width:fit-content;
  background:var(--surface-2,#100b17); border:1px solid var(--line-soft,#1d1528); color:var(--text-dim,#a99cbe); }
.dpl-status[data-level="run"] { color:var(--accent,#b57bff); border-color:var(--accent,#b57bff); }
.dpl-status[data-level="ok"] { color:var(--good,#35d07f); border-color:var(--good,#35d07f); }
.dpl-status[data-level="bad"] { color:var(--bad,#ff4d5e); border-color:var(--bad,#ff4d5e); }
.dpl-log { flex:1; min-height:0; margin:0; overflow:auto; white-space:pre;
  font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px; line-height:1.4;
  color:var(--text-dim,#a99cbe); background:#070510; border:1px solid var(--line-soft,#1d1528);
  border-radius:6px; padding:8px 10px; }
.dpl-log::-webkit-scrollbar { width:8px; }
.dpl-log::-webkit-scrollbar-thumb { background:var(--line,#38294c); border-radius:4px; }
`;
  document.head.appendChild(style);
}

// ---- DOM ---------------------------------------------------------------------
function build(container: HTMLElement): void {
  container.textContent = '';
  container.classList.add('dpl-root');

  const btn = document.createElement('button');
  btn.className = 'dpl-btn';
  btn.textContent = 'Deploy robot code';
  btn.addEventListener('click', onDeployClick);
  btnEl = btn;

  const cancel = document.createElement('button');
  cancel.className = 'dpl-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', onCancelClick);
  cancelEl = cancel;

  // Project selector.
  const selLabel = document.createElement('span');
  selLabel.className = 'dpl-select-label';
  selLabel.textContent = 'Project:';
  const select = document.createElement('select');
  select.className = 'dpl-select';
  for (const t of TARGETS) {
    const opt = document.createElement('option');
    opt.value = t.key;
    opt.textContent = t.label;
    select.append(opt);
  }
  select.value = selectedTarget;
  select.addEventListener('change', () => {
    selectedTarget = (select.value as DeployTarget);
    updateCaption();
  });
  selectEl = select;

  const row = document.createElement('div');
  row.className = 'dpl-row';
  row.append(btn, cancel, selLabel, select);

  const caption = document.createElement('div');
  caption.className = 'dpl-caption';
  captionEl = caption;
  updateCaption();

  const st = document.createElement('div');
  st.className = 'dpl-status';
  statusEl = st;

  const log = document.createElement('pre');
  log.className = 'dpl-log';
  logEl = log;

  container.append(row, caption, st, log);
  renderLog();
  renderStatus();
}

function updateCaption(): void {
  if (!captionEl) return;
  captionEl.textContent =
    `Deploys ${targetPath(selectedTarget)} — needs the robot network (tether or robot Wi-Fi)`;
}

function onDeployClick(): void {
  if (status.phase === 'running') return; // defensive; button is disabled while running
  if (btnEl) btnEl.disabled = true; // optimistic — avoids a double-click race before the IPC round-trip
  if (partialLine) {
    pushLine(partialLine);
    partialLine = '';
  }
  const target = selectedTarget; // snapshot at click; the select is disabled for the run
  pushLine(`--- deploy started ${new Date().toLocaleTimeString()} (${target.toUpperCase()}: ${targetPath(target)}) ---`);
  renderLog();
  window.companion.deploy
    .start(target)
    .then((res) => {
      if (!res.ok) pushLine(`[deploy] ${res.error}`);
      void refreshStatus();
    })
    .catch((err) => {
      // A rejected IPC promise (not just {ok:false}) must not strand the
      // optimistically-disabled button — resync from last known status.
      pushLine(`[deploy] ${String(err)}`);
      renderLog();
      renderStatus();
    });
}

function onCancelClick(): void {
  if (cancelEl) cancelEl.disabled = true;
  window.companion.deploy
    .cancel()
    .then(() => void refreshStatus())
    .catch((err) => pushLine(`[deploy] ${String(err)}`))
    .finally(() => {
      if (cancelEl) cancelEl.disabled = false;
    });
}

// ---- IPC subscriptions (registered once; survive close/reopen) -------------
let subscribed = false;
function ensureSubs(): void {
  if (subscribed) return;
  subscribed = true;
  window.companion.deploy.onOutput((chunk) => appendOutput(chunk));
  window.companion.deploy.onDone(() => void refreshStatus());
}

async function refreshStatus(): Promise<void> {
  status = await window.companion.deploy.status();
  renderStatus();
}

// ---- log buffer (module-scope, capped) --------------------------------------
// Chunks arrive at arbitrary byte boundaries, not line boundaries — carry any
// unterminated tail over to the next chunk so the capped buffer holds whole
// lines. self-check: appendOutput('a'); appendOutput('b\nc') -> buffer ['ab'],
// partialLine 'c'.
function appendOutput(chunk: string): void {
  // Normalize CR / CRLF to LF — gradle progress redraws use bare \r, which would
  // otherwise pile up inside one ever-growing "line".
  const text = (partialLine + chunk).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  partialLine = lines.pop() ?? '';
  for (const line of lines) pushLine(line);
  scheduleRenderLog();
}

// Coalesce per-chunk renders to one per animation frame — renderLog() rewrites the
// whole <pre> and reflows, which visibly stutters on rapid small gradle chunks.
let logRaf = 0;
function scheduleRenderLog(): void {
  if (logRaf) return;
  logRaf = requestAnimationFrame(() => {
    logRaf = 0;
    renderLog();
  });
}

function pushLine(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
}

function renderLog(): void {
  if (!logEl) return;
  logEl.textContent = partialLine ? logBuffer.concat(partialLine).join('\n') : logBuffer.join('\n');
  logEl.scrollTop = logEl.scrollHeight; // autoscroll
}

// ---- status line --------------------------------------------------------------
function renderStatus(): void {
  if (!statusEl || !btnEl || !cancelEl) return;
  const running = status.phase === 'running';
  btnEl.disabled = running;
  cancelEl.hidden = !running;
  if (selectEl) selectEl.disabled = running; // can't switch project mid-deploy

  let text: string;
  let level: string;
  switch (status.phase) {
    case 'running': {
      const elapsed =
        status.startedAt != null ? Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000)) : 0;
      text = `deploying… ${elapsed}s`;
      level = 'run';
      break;
    }
    case 'success':
      text = 'SUCCESS';
      level = 'ok';
      break;
    case 'failed':
      text = `FAILED (exit ${status.exitCode ?? '?'})`;
      level = 'bad';
      break;
    case 'cancelled':
      text = 'CANCELLED';
      level = 'bad';
      break;
    default:
      text = 'idle';
      level = 'dim';
  }
  statusEl.textContent = text;
  statusEl.dataset.level = level;

  // Tick the elapsed-seconds readout once a second while running; stop otherwise.
  // Self-managing: re-checked on every renderStatus() call, including its own tick.
  if (running && tickTimer == null) {
    tickTimer = window.setInterval(renderStatus, 1000);
  } else if (!running && tickTimer != null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

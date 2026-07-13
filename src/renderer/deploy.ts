// Deploy panel: drives `window.companion.deploy` (see ARCHITECTURE.md "Deploy
// (main) + IPC") to run `gradlew deploy` for the robot project and stream its
// output live. Panel-registry contract: mount(container) may be called more
// than once (reopen from "+ Panels"), so DOM + one-shot IPC subscriptions
// follow the same split used elsewhere (panels.ts ensure*Subs): the log
// buffer and run status live in MODULE scope so they survive a panel
// close/reopen mid-run; mount() just rebuilds the DOM and re-renders them.
import type { DeployStatus } from '../main/preload';

const MAX_LOG_LINES = 2000;

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
  padding:14px; font-family:var(--font-body,"Segoe UI",system-ui,sans-serif); color:var(--text,#eaf0f8); }
.dpl-row { display:flex; align-items:center; gap:10px; }
.dpl-btn { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:13px; font-weight:700;
  letter-spacing:1px; text-transform:uppercase; color:#1a1206; background:var(--accent,#ffb020);
  border:1px solid var(--accent,#ffb020); border-radius:6px; padding:10px 20px; cursor:pointer; }
.dpl-btn:hover:not(:disabled) { background:#ffc24a; }
.dpl-btn:disabled { opacity:0.45; cursor:not-allowed; }
.dpl-cancel { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:12px; letter-spacing:1px;
  text-transform:uppercase; color:var(--text-dim,#8b9bb0); background:var(--surface,#101825);
  border:1px solid var(--line,#223449); border-radius:6px; padding:9px 16px; cursor:pointer; }
.dpl-cancel:hover { color:var(--text,#eaf0f8); border-color:var(--bad,#ff4d5e); }
.dpl-cancel[hidden] { display:none; }
.dpl-caption { font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px;
  color:var(--text-faint,#566577); }
.dpl-status { font-family:var(--font-display,"Bahnschrift",sans-serif); font-size:13px; letter-spacing:1px;
  text-transform:uppercase; padding:6px 10px; border-radius:6px; width:fit-content;
  background:var(--surface-2,#0b111b); border:1px solid var(--line-soft,#16202e); color:var(--text-dim,#8b9bb0); }
.dpl-status[data-level="run"] { color:var(--accent,#ffb020); border-color:var(--accent,#ffb020); }
.dpl-status[data-level="ok"] { color:var(--good,#35d07f); border-color:var(--good,#35d07f); }
.dpl-status[data-level="bad"] { color:var(--bad,#ff4d5e); border-color:var(--bad,#ff4d5e); }
.dpl-log { flex:1; min-height:0; margin:0; overflow:auto; white-space:pre;
  font-family:var(--font-mono,"Cascadia Mono",monospace); font-size:11px; line-height:1.4;
  color:var(--text-dim,#8b9bb0); background:#05080d; border:1px solid var(--line-soft,#16202e);
  border-radius:6px; padding:8px 10px; }
.dpl-log::-webkit-scrollbar { width:8px; }
.dpl-log::-webkit-scrollbar-thumb { background:var(--line,#223449); border-radius:4px; }
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

  const row = document.createElement('div');
  row.className = 'dpl-row';
  row.append(btn, cancel);

  const caption = document.createElement('div');
  caption.className = 'dpl-caption';
  caption.textContent = 'Deploys C:\\FRC\\Helios-2026 — needs the robot network (tether or robot Wi-Fi)';

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

function onDeployClick(): void {
  if (status.phase === 'running') return; // defensive; button is disabled while running
  if (btnEl) btnEl.disabled = true; // optimistic — avoids a double-click race before the IPC round-trip
  if (partialLine) {
    pushLine(partialLine);
    partialLine = '';
  }
  pushLine(`--- deploy started ${new Date().toLocaleTimeString()} ---`);
  renderLog();
  window.companion.deploy
    .start()
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

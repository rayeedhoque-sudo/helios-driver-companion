// Limelight: MJPEG stream into img#limelight-stream + status overlay on
// canvas#limelight-overlay. Two independent failure signals drive the overlay:
//   - "no camera": the <img> isn't receiving the stream -> bounded retry: up to
//     MAX_ATTEMPTS connect() tries, 2s apart, then STOP and idle in NO CAMERA
//     with a Refresh button (#limelight-refresh) — no background retry loop
//     while idle. Mount, a settings host change, or clicking Refresh all start
//     a fresh attempt cycle.
//   - "stale": NT is connected but the Limelight heartbeat topic hasn't ticked
//     recently -> the LL process is alive-ish on network but not the stream
//     source of truth. Only shown when NT itself is connected (nt.ts already
//     surfaces "NT disconnected" via the top bar).
//
// Verified against a real Chromium <img>: for a multipart/x-mixed-replace
// response, 'load' fires exactly once (on the first part), never again per
// frame. Worse, if the server-side connection is closed cleanly (no explicit
// protocol error, e.g. the LL process dies but the socket just FINs), Chromium
// treats that as a normal end-of-body -- neither 'load' nor 'error' fires
// again, so a dead stream can sit "connected" forever showing a frozen frame.
// ponytail: reading pixels off a canvas to detect a frozen frame would need
// CORS headers the real Limelight doesn't send (drawImage/getImageData taints
// the canvas cross-origin) -- so instead a hidden probe <img> opens a second
// stream connection every HEALTH_RECONNECT_MS and, once its first frame
// arrives, is swapped in as the visible element. Seamless: the probe already
// has a rendered frame at swap time, so the video never blanks. (Restarting
// the one visible <img> in place -- the previous approach -- blacked the feed
// out for the whole reconnect, a visible "Limelight goes out" every 6 s on
// the bandwidth-capped radio.) If the probe gets no frame, the stream really
// is dead, and the existing bounded-retry/idle machinery below takes over on
// the visible element exactly as before.
import { onSettings, getSettings } from './store';
import { onValue, onConnection, TOPICS } from './nt';

const RETRY_MS = 2000; // reconnect cadence while cycling
const MAX_ATTEMPTS = 3; // connect() tries per cycle before idling
const HEALTH_RECONNECT_MS = 6000; // re-verify cadence while connected (see note above)
const STALE_MS = 2000;
const CONNECT_TIMEOUT_MS = 4000; // watchdog: a connect() attempt that never gets load/error

let img: HTMLImageElement | null = null;
let overlay: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let paneStat: HTMLElement | null = null;
let refreshBtn: HTMLButtonElement | null = null;
let size = { cssW: 0, cssH: 0 };

let host = '';
let streamOk = false; // <img> has an established, live multipart connection
let cycling = false; // true while an attempt cycle is active; false = idle, wait for Refresh
let attempt = 0; // connect() calls used in the current cycle
let awaitingSince = 0; // set while a connect() attempt is outstanding (no load/error yet)
let lastConnectMs = 0;

let ntConnected = false;
let lastHb: unknown = undefined;
let lastHbChangeMs = Date.now();

// Build the limelight panel (video img + status overlay + stat/refresh badges)
// inside the given dockview container. Re-invokable (reopen from the + menu).
export function mountLimelight(container: HTMLElement): void {
  container.classList.add('limelight-body');
  container.textContent = '';

  img = document.createElement('img');
  img.id = 'limelight-stream';
  img.alt = 'Limelight camera stream';

  overlay = document.createElement('canvas');
  overlay.id = 'limelight-overlay';

  paneStat = document.createElement('span');
  paneStat.className = 'pane-stat ll-stat';
  paneStat.textContent = 'NO SIGNAL';

  // Reuses the existing .pane-toggle badge style (same one field.ts's
  // orientation toggle uses); positioned via inline styles per this panel's
  // own layout, not style.css, so it can't collide with other panels' CSS.
  refreshBtn = document.createElement('button');
  refreshBtn.id = 'limelight-refresh';
  refreshBtn.type = 'button';
  refreshBtn.className = 'pane-toggle';
  refreshBtn.title = 'Force reconnect';
  refreshBtn.textContent = 'REFRESH';
  Object.assign(refreshBtn.style, {
    position: 'absolute',
    top: '30px',
    right: '8px',
    zIndex: '3',
  });
  refreshBtn.addEventListener('click', () => startCycle());

  container.append(img, overlay, paneStat, refreshBtn);
  ctx = overlay.getContext('2d');

  img.addEventListener('load', onFrame);
  img.addEventListener('error', onStreamError);

  // Per-mount observer on the new container (drop any observer from a prior mount).
  ro?.disconnect();
  ro = new ResizeObserver(resize);
  ro.observe(container);

  // Re-read the host BEFORE wiring subs: ensureLimelightSubs()'s onSettings
  // registration fires its callback immediately/synchronously on the first
  // subscribe (store.ts: "fires once immediately if initialized"), so `host`
  // must already match the real value here or that immediate fire sees a
  // false "change" (host still '') and kicks off a spurious extra cycle.
  host = getSettings().limelightHost;
  ensureLimelightSubs();

  // Kick a fresh attempt cycle using the current host.
  streamOk = false;
  startCycle();
  resize();
  render();
}

let ro: ResizeObserver | null = null;
let limelightSubscribed = false;
function ensureLimelightSubs(): void {
  if (limelightSubscribed) return;
  limelightSubscribed = true;

  window.addEventListener('resize', resize);

  onSettings((s) => {
    if (s.limelightHost !== host) {
      host = s.limelightHost;
      streamOk = false;
      startCycle();
      render();
    }
  });

  onValue(TOPICS.limelight + '/hb', (v) => {
    if (v !== lastHb) {
      lastHb = v;
      lastHbChangeMs = Date.now();
    }
  });
  onConnection((c) => {
    ntConnected = c.connected;
  });

  // Watchdog + overlay repaint tick (staleness and stalled-stream both need polling).
  setInterval(tick, 500);
}

function streamUrl(): string {
  return `http://${host}:5800/stream.mjpg?_=${Date.now()}`;
}

// Start (or restart) a bounded attempt cycle: mount, host change, and the
// Refresh button all funnel through here.
function startCycle(): void {
  attempt = 0;
  cycling = true;
  connect();
}

function connect(): void {
  if (!img || !host) return;
  attempt++;
  console.log(`[limelight] connect attempt ${attempt}/${MAX_ATTEMPTS}`);
  lastConnectMs = awaitingSince = Date.now();
  img.src = streamUrl();
}

function onFrame(): void {
  awaitingSince = 0;
  attempt = 0;
  if (!streamOk) {
    streamOk = true;
    console.log('[limelight] stream connected');
  }
  render();
}

function onStreamError(): void {
  awaitingSince = 0;
  if (streamOk) console.log('[limelight] stream lost');
  streamOk = false;
  if (attempt >= MAX_ATTEMPTS) {
    cycling = false; // exhausted this cycle -> idle, wait for manual Refresh
    console.log('[limelight] retries exhausted, idle (press Refresh)');
  }
  render();
}

// Runs every 500ms:
//  - pauses the stream entirely while the panel tab is hidden (dockview DETACHES
//    hidden tabs but keeps them mounted — without this the <img> keeps pulling
//    MJPEG over the bandwidth-capped field radio forever), resumes on re-attach
//  - watchdog for a connect() attempt that never resolves (no load/error)
//  - while `cycling`, schedules the next attempt RETRY_MS after the last one
//    (stops itself once MAX_ATTEMPTS is hit, via onStreamError above)
//  - while streamOk, periodic self-check reconnect (HEALTH_RECONNECT_MS, see
//    file-header note on why this is necessary for multipart streams)
// plus repaints the overlay so staleness reflects live hb/NT state.
let pausedHidden = false;
function tick(): void {
  if (img && !img.isConnected) {
    if (!pausedHidden) {
      pausedHidden = true;
      awaitingSince = 0;
      streamOk = false;
      img.src = ''; // aborts the in-flight MJPEG fetch
      console.log('[limelight] panel hidden — stream paused');
    }
    return;
  }
  if (pausedHidden) {
    pausedHidden = false;
    console.log('[limelight] panel visible — stream resuming');
    startCycle();
    return;
  }
  const now = Date.now();
  if (awaitingSince && now - awaitingSince > CONNECT_TIMEOUT_MS) {
    onStreamError();
  } else if (cycling && !streamOk && !awaitingSince && now - lastConnectMs > RETRY_MS) {
    if (attempt < MAX_ATTEMPTS) connect();
  } else if (streamOk && !awaitingSince && now - lastConnectMs > HEALTH_RECONNECT_MS) {
    healthCheck();
  }
  render();
}

// While healthy, verify the stream end-to-end WITHOUT touching the visible
// <img> (see the probe-swap note in the file header). First frame on the
// probe -> adopt it as the visible element; error or no frame within
// CONNECT_TIMEOUT_MS -> the stream is actually dead, hand the visible img to
// the normal bounded-retry cycle.
function healthCheck(): void {
  if (!img || !host) return;
  lastConnectMs = Date.now();
  const probe = document.createElement('img');
  probe.alt = 'Limelight camera stream';
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    probe.src = ''; // aborts the probe's in-flight MJPEG fetch
    console.log('[limelight] health check failed — stream presumed dead');
    onStreamError(); // streamOk=false; tick()'s retry machinery takes it from here
  };
  const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
  probe.addEventListener('error', fail, { once: true });
  probe.addEventListener(
    'load',
    () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!img || pausedHidden) {
        probe.src = ''; // panel went away mid-probe; drop the extra connection
        return;
      }
      // Adopt the probe: the id carries the CSS, the listeners carry future
      // stream-error handling. The old element's connection dies with it.
      // Detach the old element's listeners FIRST: clearing src fires a
      // spurious 'error' event, and with onStreamError still attached that
      // reads as "stream died" -> NO CAMERA flash + reconnect every cycle
      // (the exact glitch this probe-swap exists to remove).
      probe.id = img.id;
      probe.addEventListener('load', onFrame);
      probe.addEventListener('error', onStreamError);
      img.removeEventListener('load', onFrame);
      img.removeEventListener('error', onStreamError);
      img.replaceWith(probe);
      img.src = ''; // aborts the old element's stream fetch
      img = probe;
      onFrame();
    },
    { once: true },
  );
  probe.src = streamUrl();
}

function resize(): void {
  if (!overlay || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = overlay.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));
  overlay.width = Math.round(cssW * dpr);
  overlay.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  size = { cssW, cssH };
  render();
}

function render(): void {
  if (!ctx) return;
  const { cssW, cssH } = size;
  ctx.clearRect(0, 0, cssW, cssH);

  if (!streamOk) {
    const msg = cycling ? 'NO CAMERA — retrying…' : 'NO CAMERA — press Refresh to retry';
    paint(msg, 'rgba(5,8,13,0.88)', '#ff4d5e');
    setStat('NO SIGNAL');
    refreshBtn?.classList.toggle('active', !cycling);
    return;
  }
  refreshBtn?.classList.remove('active');

  const stale = ntConnected && Date.now() - lastHbChangeMs > STALE_MS;
  if (stale) {
    paint('STALE', 'rgba(255,176,32,0.16)', '#ffc94d');
    setStat('STALE');
    return;
  }

  setStat('LIVE');
}

function paint(text: string, bg: string, fg: string): void {
  if (!ctx) return;
  const { cssW, cssH } = size;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = fg;
  ctx.font = '600 20px "Bahnschrift", "Segoe UI Variable Display", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cssW / 2, cssH / 2);
}

function setStat(text: string): void {
  if (paneStat) paneStat.textContent = text;
}

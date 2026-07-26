// Renderer bootstrap: init store, build the dockview shell, mount registry panels,
// restore the persisted layout, wire the top bar, dock strip, and NT status.
//
// Layout: the top bar and the bottom DS dock strip are FIXED chrome (the embedded
// Driver Station is a native Win32 window floating over our content — dsdock.ts
// depends on the strip's reported zone rect). Everything between them is a
// dockview-core dock: every panel in panels-registry.ts is a draggable, closable,
// splittable tab. The layout persists into settings (`layout` key) and restores on
// boot; "+ Panels" reopens closed panels; the settings modal has "Reset layout".
import type { CompanionApi, DsStatus } from '../main/preload';
import {
  createDockview,
  themeDark,
  type DockviewApi,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
  type SerializedDockview,
  type DockviewGroupPanel,
  type IDockviewPanel,
} from 'dockview-core';
import { initStore, getSettings, updateSettings, onSettings, type Settings } from './store';
import { PANELS, getPanelDef } from './panels-registry';
import { onConnection, getConnState, ntConnect, type ConnState } from './nt';
import { armDsStationAdopt } from './field';
import {
  startGestures,
  stopGestures,
  isRunning,
  onGestureStatus,
  type GestureActions,
} from './gestures';

declare global {
  interface Window {
    companion: CompanionApi;
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function effectiveHost(s: Settings): string {
  return s.simMode ? '127.0.0.1' : s.ntHost;
}

// ---- dockview shell ---------------------------------------------------------
let dock: DockviewApi | null = null;

// Bridges dockview's content-renderer contract to the registry's mount(container).
class PanelContent implements IContentRenderer {
  readonly element: HTMLElement = document.createElement('div');
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
    this.element.className = 'dc-panel';
  }
  init(_params: GroupPanelPartInitParameters): void {
    const def = getPanelDef(this.name);
    if (def) def.mount(this.element);
    else this.element.textContent = `unknown panel: ${this.name}`;
  }
}

function addPanelOpts(id: string): { id: string; component: string; title: string } {
  return { id, component: id, title: getPanelDef(id)?.title ?? id };
}

// Open a registry panel: focus it if it already exists, else add it (new tab in
// the active group).
function openPanel(api: DockviewApi, id: string): void {
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  if (getPanelDef(id)) api.addPanel(addPanelOpts(id));
}

// Default layout approximating the old fixed grid:
// limelight (~40%) | field (~38%) | right column (~22%): power over the two
// graphs (tabbed) over mechanisms/vision/chooser (tabbed). laptop-map and deploy
// stay closed by default — open them from "+ Panels".
function defaultLayout(api: DockviewApi): void {
  api.clear();
  const limelight = api.addPanel(addPanelOpts('limelight'));
  api.addPanel({ ...addPanelOpts('field'), position: { referencePanel: 'limelight', direction: 'right' } });
  const power = api.addPanel({ ...addPanelOpts('power'), position: { referencePanel: 'field', direction: 'right' } });
  const volt = api.addPanel({ ...addPanelOpts('graph-voltage'), position: { referencePanel: 'power', direction: 'below' } });
  api.addPanel({ ...addPanelOpts('graph-current'), position: { referencePanel: 'graph-voltage', direction: 'within' } });
  api.addPanel({ ...addPanelOpts('mechanisms'), position: { referencePanel: 'graph-voltage', direction: 'below' } });
  api.addPanel({ ...addPanelOpts('vision-link'), position: { referencePanel: 'mechanisms', direction: 'within' } });
  api.addPanel({ ...addPanelOpts('auto-chooser'), position: { referencePanel: 'mechanisms', direction: 'within' } });

  // Column widths / right-column row heights, from the live container size.
  const root = el('dock-root');
  const w = root.clientWidth || 1900;
  const h = root.clientHeight || 950;
  limelight.api.setSize({ width: w * 0.4 });
  power.api.setSize({ width: w * 0.22, height: h * 0.36 });
  volt.api.setSize({ height: h * 0.28 });

  // Front tab of each stacked group, then land focus on the limelight panel.
  api.getPanel('graph-voltage')?.api.setActive();
  api.getPanel('mechanisms')?.api.setActive();
  api.getPanel('limelight')?.api.setActive();
}

// Pick the dock group that belongs to one side of the screen. Groups are ordered by
// their on-screen x, so 'left' is the leftmost and 'right' the rightmost.
//
// Sized for a TWO-way split, which is the only arrangement gestures are meant to
// drive. With a single group both sides resolve to it, so gestures still work
// un-split. With three or more the middle groups are simply unreachable by gesture
// (the mouse and "+ Panels" still reach them) — deliberately not solved, because a
// 3-way split has no natural left/right mapping to two hands.
function groupForSide(api: DockviewApi, side: 'left' | 'right'): DockviewGroupPanel | undefined {
  const groups = api.groups
    .slice()
    .sort((a, b) => a.element.getBoundingClientRect().left - b.element.getBoundingClientRect().left);
  if (groups.length === 0) return undefined;
  return side === 'left' ? groups[0] : groups[groups.length - 1];
}

// Step the active tab WITHIN one side's group. This is what stops a gesture crossing
// between the two halves: it never touches api.moveToNext, which walks the whole dock
// regardless of groups.
//
// CLAMPS at the ends, it does not wrap. With tabs 1-2-3, swiping past 3 stays on 3
// and swiping back past 1 stays on 1 — a swipe can never jump the whole width of the
// group. Same rule in both directions and on both sides. Requested 2026-07-26:
// wrapping made a single overshoot land at the far end, which reads as the panel
// having jumped somewhere random rather than as hitting a limit.
function cycleSide(api: DockviewApi, side: 'left' | 'right', step: 1 | -1): void {
  const group = groupForSide(api, side);
  if (!group) return;
  const panels = group.panels;
  if (panels.length === 0) return;
  const current = group.activePanel;
  const i = current ? panels.indexOf(current) : 0;
  const next = i + step;
  if (next < 0 || next >= panels.length) {
    console.log(`[gesture] ${side}: already at the ${step > 0 ? 'last' : 'first'} tab`);
    return;
  }
  panels[next]?.api.setActive();
}

// ---- pinch-drag: move a tab between the two halves --------------------------
// pinchStart grabs the active tab of the hand's own side; pinchMove previews where
// it would land; pinchDrop commits. The preview exists because a drop rewrites the
// persisted layout — you should be able to see the destination before letting go.
let dragPanel: IDockviewPanel | null = null;
let dragTarget: 'left' | 'right' | null = null;

function dragPreviewEl(): HTMLElement {
  return el('drag-preview');
}

function hideDragPreview(): void {
  dragPreviewEl().classList.remove('open');
}

function beginDrag(api: DockviewApi, side: 'left' | 'right'): void {
  const panel = groupForSide(api, side)?.activePanel ?? null;
  dragPanel = panel;
  dragTarget = side;
  if (!panel) return; // nothing on that side to pick up — stay inert
  const p = dragPreviewEl();
  p.textContent = `moving "${panel.title}"`;
  p.classList.add('open');
  console.log(`[gesture] grabbed "${panel.title}" from the ${side}`);
}

// Preview follows the hand: whichever half of the frame it is over is the half the
// tab lands in. x is already mirrored, so 0 is the user's left and matches the
// screen's left.
function updateDrag(api: DockviewApi, x: number): void {
  if (!dragPanel) return;
  const side: 'left' | 'right' = x < 0.5 ? 'left' : 'right';
  dragTarget = side;
  const group = groupForSide(api, side);
  const p = dragPreviewEl();
  if (!group) return;
  const r = group.element.getBoundingClientRect();
  p.style.left = `${r.left}px`;
  p.style.top = `${r.top}px`;
  p.style.width = `${r.width}px`;
  p.style.height = `${r.height}px`;
  const already = dragPanel.api.group === group;
  p.textContent = already ? `"${dragPanel.title}" — stays here` : `move "${dragPanel.title}" here`;
  p.classList.toggle('same', already);
}

function commitDrag(api: DockviewApi): void {
  const panel = dragPanel;
  const side = dragTarget;
  dragPanel = null;
  dragTarget = null;
  hideDragPreview();
  if (!panel || !side) return;
  const group = groupForSide(api, side);
  // Dropping a tab back on its own group is a no-op, not a move — this is what keeps
  // an aborted drag from churning the persisted layout for no reason.
  if (!group || panel.api.group === group) {
    console.log('[gesture] drop cancelled — same group');
    return;
  }
  panel.api.moveTo({ group });
  console.log(`[gesture] moved "${panel.title}" to the ${side}`);
}

function cancelDrag(): void {
  if (dragPanel) console.log('[gesture] drag cancelled — nothing moved');
  dragPanel = null;
  dragTarget = null;
  hideDragPreview();
}

function restoreLayout(api: DockviewApi): void {
  const saved = getSettings().layout;
  if (saved) {
    try {
      api.fromJSON(saved as SerializedDockview);
      console.log('[layout] restored from settings');
      return;
    } catch (err) {
      console.error('[layout] restore failed — using default:', err);
      try {
        api.clear();
      } catch {
        /* already unusable state; defaultLayout clears again anyway */
      }
    }
  }
  defaultLayout(api);
  console.log('[layout] default layout applied');
}

// Auto-persist the layout (debounced) into settings on every layout change.
let saveTimer: number | undefined;
function wireLayoutPersistence(api: DockviewApi): void {
  api.onDidLayoutChange(() => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void updateSettings({ layout: api.toJSON() }).then(() => console.log('[layout] saved'));
    }, 400);
  });
}

// Keyboard panel navigation. Ctrl+1..9 opens/focuses the Nth registry panel;
// Ctrl+Tab / Ctrl+Shift+Tab cycles focus through the open ones.
//
// SAFETY: these only ever call openPanel / moveToNext / moveToPrevious — they move
// FOCUS, never a panel and never a click. Nothing here can reach a Controls or
// Deploy button, and moveToNext/Previous don't mutate the layout, so a mistaken
// keypress can't churn the persisted layout blob either. Keep it that way.
function wireKeybinds(api: DockviewApi): void {
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    // Don't steal keys from the settings modal's text inputs.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) api.moveToPrevious({ includePanel: true });
      else api.moveToNext({ includePanel: true });
      return;
    }
    // Ctrl+1..9 -> registry panels 1..9. Panels past the 9th stay menu-only.
    if (e.shiftKey) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const def = PANELS[n - 1];
    if (!def) return;
    e.preventDefault();
    openPanel(api, def.id);
  });
}

// Which panel each finger-count gesture opens: 1 finger -> [0], 2 -> [1], 3 -> [2].
// Only 1-3 are reachable, because 4+ extended fingers is the swipe pose.
//
// Listed explicitly rather than read off PANELS[n - 1]. The registry order also
// drives Ctrl+1..9 AND is the layout-persistence order, so reordering the registry
// to change what a gesture opens would quietly move those too. Changing a gesture
// should be a one-line edit here and touch nothing else.
//
// NOTE: Ctrl+1..9 still follows registry order, so Ctrl+3 opens Orientation while
// three fingers opens Controls. Deliberate — only the gesture was asked to change.
const GESTURE_PANELS: readonly string[] = ['limelight', 'field', 'controls'];

// Webcam gesture control. The focus actions carry the same safety argument as the
// keybinds above — they can't click anything; pinch drag is the one exception and is
// documented in gestures.ts.
//
// Both toggles persist. `gesturesOn` DEFAULTS TO TRUE, so the app arms the camera at
// launch — asked for 2026-07-26, and a deliberate reversal of the original "never
// boot with the camera live" stance. Turning it off in the top bar is remembered.
// `previewOn` defaults to false: the thumbnail is opt-in, and it is still forced
// visible whenever the camera is live and the user has asked to see it.
function wireGestures(api: DockviewApi): void {
  const btn = el<HTMLButtonElement>('btn-gestures');
  const previewBtn = el<HTMLButtonElement>('btn-preview');
  const badge = el('gesture-badge');
  const preview = el<HTMLVideoElement>('gesture-preview');

  const actions: GestureActions = {
    openNth: (n) => {
      const id = GESTURE_PANELS[n - 1];
      if (id) openPanel(api, id);
    },
    // Side-scoped: a gesture only ever cycles the half its hand owns.
    focusNext: (side) => cycleSide(api, side, 1),
    focusPrev: (side) => cycleSide(api, side, -1),
    pinchStart: (side) => beginDrag(api, side),
    pinchMove: (x) => updateDrag(api, x),
    pinchDrop: () => commitDrag(api),
    pinchCancel: () => cancelDrag(),
  };

  // Debug/verification hook, same precedent as __dock above: the side-isolation
  // rule can only be exercised against a real split dock, not the unit harness.
  (window as Window & { __gestureActions?: GestureActions }).__gestureActions = actions;

  onGestureStatus((text, kind) => {
    badge.textContent = text;
    badge.className = `gesture-badge ${kind}`;
  });

  const render = (): void => {
    btn.classList.toggle('tbtn-accent', isRunning());
    btn.textContent = isRunning() ? 'Gestures ON' : 'Gestures';
    document.body.classList.toggle('gestures-on', isRunning());
    const showPreview = getSettings().previewOn;
    previewBtn.classList.toggle('tbtn-accent', showPreview);
    document.body.classList.toggle('preview-on', showPreview);
    // The thumbnail is only meaningful while the camera is actually running.
    previewBtn.disabled = !isRunning();
  };

  const arm = (): void => {
    btn.disabled = true;
    void startGestures(actions, preview)
      .catch((err: unknown) => {
        console.error('[gestures] start failed:', err);
        badge.textContent = 'camera unavailable';
        badge.className = 'gesture-badge error';
        stopGestures();
      })
      .finally(() => {
        btn.disabled = false;
        render();
      });
  };

  btn.addEventListener('click', () => {
    const nowOn = !isRunning();
    if (!nowOn) {
      stopGestures();
      cancelDrag(); // never leave a half-finished grab behind
      render();
    } else {
      arm();
    }
    void updateSettings({ gesturesOn: nowOn });
  });

  previewBtn.addEventListener('click', () => {
    void updateSettings({ previewOn: !getSettings().previewOn }).then(render);
  });

  // A typo in GESTURE_PANELS would make that gesture silently do nothing, since
  // openPanel ignores unknown ids. Say so loudly at boot instead.
  for (const id of GESTURE_PANELS) {
    if (!getPanelDef(id)) console.error(`[gestures] GESTURE_PANELS references unknown panel id "${id}"`);
  }

  render();
  if (getSettings().gesturesOn) arm();
}

// "+ Panels" top-bar menu: lists every registry panel; click opens/focuses it.
function wirePanelsMenu(api: DockviewApi): void {
  const btn = el('btn-panels');
  const menu = el('panels-menu');
  const hide = (): void => menu.classList.remove('open');

  const rebuild = (): void => {
    menu.textContent = '';
    for (const def of PANELS) {
      const item = document.createElement('button');
      item.className = 'panels-menu-item';
      item.classList.toggle('is-open', !!api.getPanel(def.id));
      item.textContent = def.title;
      item.addEventListener('click', () => {
        openPanel(api, def.id);
        hide();
      });
      menu.appendChild(item);
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('open')) {
      hide();
    } else {
      rebuild();
      menu.classList.add('open');
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target as Node)) hide();
  });
}

// ---- boot --------------------------------------------------------------------
async function boot(): Promise<void> {
  const initial = await window.companion.getSettings();
  initStore(initial);

  dock = createDockview(el('dock-root'), {
    theme: { ...themeDark, gap: 4 },
    createComponent: (opts) => new PanelContent(opts.name),
  });
  // Debug/verification hook (used by the CDP harness; harmless in production).
  (window as Window & { __dock?: DockviewApi }).__dock = dock;
  restoreLayout(dock);
  wireLayoutPersistence(dock);
  wirePanelsMenu(dock);
  wireKeybinds(dock);
  wireGestures(dock);

  // The station picker + follow-the-DS lock now live inside the field panel (field.ts).
  wireSettingsModal();
  wireDsButtons();
  wireNtStatus();
  wireDockStrip();

  // Connect NT to the effective host now and whenever settings change (ntConnect is idempotent).
  onSettings((s) => ntConnect(effectiveHost(s)));
}

function wireSettingsModal(): void {
  const modal = el('settings-modal');
  const ntHost = el<HTMLInputElement>('set-nt-host');
  const sim = el<HTMLInputElement>('set-sim-mode');
  const ll = el<HTMLInputElement>('set-limelight-host');

  const open = (): void => {
    const s = getSettings();
    ntHost.value = s.ntHost;
    sim.checked = s.simMode;
    ll.value = s.limelightHost;
    modal.classList.add('open');
  };
  const close = (): void => modal.classList.remove('open');

  el('btn-settings').addEventListener('click', open);
  el('set-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  el('set-save').addEventListener('click', () => {
    void updateSettings({
      ntHost: ntHost.value.trim(),
      simMode: sim.checked,
      limelightHost: ll.value.trim(),
    }).then(close);
  });
  // Reset layout: rebuild the default arrangement and persist it immediately.
  el('set-reset-layout').addEventListener('click', () => {
    if (dock) {
      defaultLayout(dock);
      void updateSettings({ layout: dock.toJSON() });
      console.log('[layout] reset to default');
    }
    close();
  });
}

function wireDsButtons(): void {
  const dockBtn = el<HTMLButtonElement>('btn-dock');
  const strip = el('dock-strip');
  let dsDocked = false;

  dockBtn.addEventListener('click', () =>
    void (dsDocked ? window.companion.ds.undock() : window.companion.ds.dock()),
  );
  el('btn-launch-ds').addEventListener('click', () => {
    armDsStationAdopt(); // the freshly-launched DS reads its ini — adopt that station
    void window.companion.ds.launch();
  });

  const render = (st: DsStatus): void => {
    dsDocked = st.docked;
    dockBtn.textContent = st.docked ? 'Undock DS' : 'Dock DS';
    strip.classList.toggle('docked', st.docked);
    if (st.heightDip) strip.style.setProperty('--ds-height', `${st.heightDip}px`);
  };
  window.companion.ds.onStatus(render);
  // Pull the initial status too — main pushes before this subscription exists.
  void window.companion.ds.status().then(render);
  window.companion.ds.onHover((h) => strip.classList.toggle('highlight', h));
}

function wireNtStatus(): void {
  const node = el('nt-status');
  const rtt = node.querySelector<HTMLElement>('.rtt');
  const render = (c: ConnState): void => {
    node.classList.toggle('online', c.connected);
    node.classList.toggle('offline', !c.connected);
    if (rtt) {
      rtt.textContent = c.connected
        ? c.rttMs != null
          ? `${Math.round(c.rttMs)} ms`
          : '— ms'
        : 'OFFLINE';
    }
  };
  onConnection(render);
  render(getConnState());
}

function wireDockStrip(): void {
  const strip = el('dock-strip');
  const report = (): void => {
    const r = strip.getBoundingClientRect();
    // Publish the live strip height so the gesture thumbnail can sit ABOVE it. The
    // docked Driver Station is a reparented native Win32 window that paints over any
    // z-index, so a thumbnail inside the strip would vanish exactly when the DS is up.
    document.documentElement.style.setProperty('--dock-strip-h', `${Math.round(r.height)}px`);
    // Logged so the dock-zone plumbing stays verifiable from stdout (dsdock depends on it).
    console.log(
      `[dock-strip] zone rect ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    );
    window.companion.ds.setZoneRect({ x: r.left, y: r.top, w: r.width, h: r.height });
  };
  new ResizeObserver(report).observe(strip);
  window.addEventListener('resize', report);
  report();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}

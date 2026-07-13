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
} from 'dockview-core';
import { initStore, getSettings, updateSettings, onSettings, type Settings } from './store';
import { PANELS, getPanelDef } from './panels-registry';
import { onConnection, getConnState, ntConnect, type ConnState } from './nt';
import { armDsStationAdopt } from './field';

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

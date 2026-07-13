// Panel registry — the FROZEN contract between the dockview shell and every panel.
//
// Adding or replacing a panel is entirely local to this file plus the panel's own
// module: give it a stable `id`, a tab `title`, and a `mount(container)` that
// populates the passed element. `mount` is called once each time the panel is
// opened (including reopen from the "+ Panels" menu), so it must (re)build its DOM
// into a fresh, empty container and may be invoked more than once over the app's
// life. Anything that must run only once (NT subscriptions, timers) belongs behind
// a module-level guard inside the panel (see panels.ts `ensure*Subs`), not in mount.
//
// `id` doubles as the dockview panel id and the layout-persistence key, so DO NOT
// rename an existing id — a renamed id orphans it in any saved layout. Follow-up
// agents: replace a stub by swapping the `mount` reference here (and implementing it
// in the owning module); the id/title/contract stay put.
import { mountLimelight } from './limelight';
import { mountField, mountLaptopMap } from './field';
import { mountVoltageGraph, mountCurrentGraph } from './graphs';
import { mountPowerBars, mountVision, mountMechanisms, mountAutoChooser, mountControls } from './panels';
import { mountDeploy } from './deploy';

export interface PanelDef {
  /** Stable id — dockview panel id + layout key. FROZEN; never rename. */
  id: string;
  /** Tab label. */
  title: string;
  /** Populate the given (fresh, empty) panel container. Called once per open. */
  mount(container: HTMLElement): void;
}

export const PANELS: readonly PanelDef[] = [
  { id: 'limelight', title: 'Limelight · Knight', mount: mountLimelight },
  { id: 'field', title: 'Field · Rebuilt 2026', mount: mountField },
  { id: 'laptop-map', title: 'Orientation', mount: mountLaptopMap }, // id kept for layout persistence
  { id: 'graph-voltage', title: 'Battery Voltage', mount: mountVoltageGraph },
  { id: 'graph-current', title: 'Total Current', mount: mountCurrentGraph },
  { id: 'power', title: 'Power', mount: mountPowerBars },
  { id: 'mechanisms', title: 'Mechanisms', mount: mountMechanisms },
  { id: 'auto-chooser', title: 'Autonomous', mount: mountAutoChooser },
  { id: 'vision-link', title: 'Vision Link', mount: mountVision },
  { id: 'deploy', title: 'Deploy', mount: mountDeploy },
  { id: 'controls', title: 'Controls', mount: mountControls },
];

export function getPanelDef(id: string): PanelDef | undefined {
  return PANELS.find((p) => p.id === id);
}

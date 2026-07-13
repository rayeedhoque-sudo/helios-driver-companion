// Settings store: tiny pub-sub cache shared across renderer modules.
// Settings / Station are the canonical config types (imported type-only by main + preload).
export type Station = 'R1' | 'R2' | 'R3' | 'B1' | 'B2' | 'B3';
export type Settings = {
  ntHost: string;
  simMode: boolean;
  limelightHost: string;
  station: Station;
  // Opaque dockview layout blob (SerializedDockview from api.toJSON()); persisted
  // verbatim. Kept `unknown` so store/main stay decoupled from dockview's types.
  layout?: unknown;
};

let cache: Settings | null = null;
const subs = new Set<(s: Settings) => void>();

// Seed the cache from the persisted settings and notify existing subscribers.
export function initStore(initial: Settings): void {
  cache = { ...initial };
  for (const cb of subs) cb(cache);
}

export function getSettings(): Settings {
  if (!cache) throw new Error('store not initialized — call initStore() first');
  return cache;
}

// Persist a patch via the main process, update the cache, then notify subscribers.
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const full = await window.companion.saveSettings(patch);
  cache = full;
  for (const cb of subs) cb(cache);
}

// Subscribe to settings changes. Fires once immediately if the store is already initialized.
export function onSettings(cb: (s: Settings) => void): void {
  subs.add(cb);
  if (cache) cb(cache);
}

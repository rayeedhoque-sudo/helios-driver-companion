// Preload: exposes window.companion. Bridge shape is FROZEN (see ARCHITECTURE.md).
import { contextBridge, ipcRenderer } from 'electron';
import type { Settings } from '../renderer/store';
import type { DsStatus } from './dsdock';
import type { DeployActionResult, DeployStatus } from './deploy';

export type { DsStatus, Settings, DeployActionResult, DeployStatus };

export interface CompanionApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  ds: {
    status(): Promise<DsStatus>;
    dock(): Promise<void>;
    undock(): Promise<void>;
    launch(): Promise<void>;
    setZoneRect(rectDip: { x: number; y: number; w: number; h: number }): void;
    onStatus(cb: (s: DsStatus) => void): void;
    onHover(cb: (hovering: boolean) => void): void;
  };
  deploy: {
    start(): Promise<DeployActionResult>;
    cancel(): Promise<DeployActionResult>;
    status(): Promise<DeployStatus>;
    onOutput(cb: (chunk: string) => void): void;
    onDone(cb: (code: number | null) => void): void;
  };
}

const api: CompanionApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  ds: {
    status: () => ipcRenderer.invoke('ds:status'),
    dock: () => ipcRenderer.invoke('ds:dock'),
    undock: () => ipcRenderer.invoke('ds:undock'),
    launch: () => ipcRenderer.invoke('ds:launch'),
    setZoneRect: (rectDip) => ipcRenderer.send('ds:zone-rect', rectDip),
    onStatus: (cb) => {
      ipcRenderer.on('ds:status-changed', (_e, s: DsStatus) => cb(s));
    },
    onHover: (cb) => {
      ipcRenderer.on('ds:hover', (_e, h: boolean) => cb(h));
    },
  },
  deploy: {
    start: () => ipcRenderer.invoke('deploy:start'),
    cancel: () => ipcRenderer.invoke('deploy:cancel'),
    status: () => ipcRenderer.invoke('deploy:status'),
    onOutput: (cb) => {
      ipcRenderer.on('deploy:output', (_e, chunk: string) => cb(chunk));
    },
    onDone: (cb) => {
      ipcRenderer.on('deploy:done', (_e, code: number | null) => cb(code));
    },
  },
};

contextBridge.exposeInMainWorld('companion', api);

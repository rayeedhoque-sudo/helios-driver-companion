// NetworkTables 4 client (M1). Exported signatures + TOPICS are FROZEN.
//
// Built on the vendored Mechanical Advantage NT4 client (./vendor/NT4.ts, BSD) rather than
// ntcore-ts-client: that library validates announced type strings against a strict zod enum,
// so a `struct:SwerveModuleState[]` announce throws and drops the whole announce frame. The
// vendored client treats unknown types as raw and hands the raw msgpack bytes to the callback.
import { NT4_Client, type NT4_Topic } from './vendor/NT4';

export type ConnState = { connected: boolean; rttMs: number | null };

type ValueCb = (value: unknown, timestampUs: number) => void;

const APP_NAME = 'HeliosCompanion';
const NT_PORT = 5810;

let client: NT4_Client | null = null;
let currentHost: string | null = null;
let connected = false;

// topic -> subscriber callbacks (per-topic subscribe on first onValue; deduped by topic).
const valueSubs = new Map<string, Set<ValueCb>>();
// topic -> NT4 subscription id, present while a server subscription is active for that topic.
const subIds = new Map<string, number>();
// topic -> type string for topics we publish (re-published after reconnect / host change).
const publishedTypes = new Map<string, string>();
// topic -> last published value. NT4_Client.addSample silently no-ops while the socket
// isn't OPEN, so the last value is cached here and re-sent on every (re)connect — a
// selection made while disconnected, or before a robot reboot, still lands.
const publishedValues = new Map<string, unknown>();

const connSubs = new Set<(s: ConnState) => void>();

export function getConnState(): ConnState {
  let rttMs: number | null = null;
  if (client && connected) {
    // NT4's timestamp handshake gives one-way latency (RTT/2); x2 -> round-trip. 0 = not yet synced.
    const oneWayUs = client.getNetworkLatency_us();
    if (oneWayUs > 0) rttMs = (oneWayUs * 2) / 1000;
  }
  return { connected, rttMs };
}

function notifyConn(): void {
  const s = getConnState();
  connSubs.forEach((cb) => cb(s));
}

export function onConnection(cb: (s: ConnState) => void): () => void {
  connSubs.add(cb);
  cb(getConnState());
  return () => connSubs.delete(cb);
}

// The RTT number only exists after the first timestamp round-trip, which lands AFTER
// onConnect fires — and it drifts as the network changes. Refresh listeners once a
// second while connected so the top-bar pip / vision-link readout show a live value
// instead of the '— ms' captured at connect time.
setInterval(() => {
  if (connected) notifyConn();
}, 1000);

// Subscribe a topic on the live client (exact match). No-op if already subscribed or no client.
function ensureSubscribed(topic: string): void {
  if (!client || subIds.has(topic)) return;
  subIds.set(topic, client.subscribe([topic], false));
}

// Subscribe to a topic; returns an unsubscribe fn.
export function onValue(topic: string, cb: ValueCb): () => void {
  let set = valueSubs.get(topic);
  if (!set) {
    set = new Set();
    valueSubs.set(topic, set);
  }
  set.add(cb);
  ensureSubscribed(topic);

  return () => {
    const s = valueSubs.get(topic);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      valueSubs.delete(topic);
      const id = subIds.get(topic);
      if (id !== undefined && client) {
        try {
          client.unsubscribe(id);
        } catch {
          /* client may have been torn down */
        }
      }
      subIds.delete(topic);
    }
  };
}

// Publish a value to a topic (typeStr e.g. 'double', 'boolean', 'string', 'string[]').
export function ntPublish(topic: string, typeStr: string, value: unknown): void {
  publishedTypes.set(topic, typeStr);
  publishedValues.set(topic, value); // re-sent on (re)connect — see publishedValues note
  if (!client) return;
  client.publishTopic(topic, typeStr); // idempotent for an already-published topic
  client.addSample(topic, value);
}

// (Re)connect to an NT4 server, idempotent on the same host.
export function ntConnect(host: string): void {
  if (client && host === currentHost) return;
  teardown();
  currentHost = host;

  // Every callback below guards `client === c`: a torn-down client whose socket was
  // still mid-handshake can fire late — its data/state must never reach the live app.
  const c = new NT4_Client(
    host,
    [NT_PORT],
    APP_NAME,
    () => {}, // onTopicAnnounce
    () => {}, // onTopicUnannounce
    () => {}, // onTopicPropertiesUpdate
    (topic: NT4_Topic, tsUs: number, value: unknown) => {
      if (client !== c) return;
      const set = valueSubs.get(topic.name);
      if (set) set.forEach((cb) => cb(value, tsUs));
    },
    () => {
      if (client !== c) return;
      connected = true;
      console.info(`[nt] connected to ${host}`);
      // Re-send the last value of every published topic (the publish itself was
      // re-registered by the client's own on-open flush; values are not).
      for (const [topic, value] of publishedValues) c.addSample(topic, value);
      notifyConn();
    },
    () => {
      if (client !== c) return;
      connected = false;
      notifyConn();
    },
  );
  client = c;

  // Re-establish subscriptions + publishers on the fresh client (NT4_Client flushes these on open).
  for (const topic of valueSubs.keys()) subIds.set(topic, c.subscribe([topic], false));
  for (const [topic, type] of publishedTypes) c.publishTopic(topic, type);

  c.connect();
  notifyConn();
}

function teardown(): void {
  if (client) {
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
  }
  client = null;
  subIds.clear(); // subscription ids belonged to the old client
  connected = false;
}

// Decode a raw struct:SwerveModuleState[] buffer.
// Layout: 16 bytes per module — f64 LE speed (m/s), then f64 LE angle (rad).
// self-check: bytes for two pairs [3.5, 1.25, -2.0, 0.5] (32 B) decode to
//   [{speedMps: 3.5, angleRad: 1.25}, {speedMps: -2.0, angleRad: 0.5}].
export function decodeSwerveModuleStates(
  raw: Uint8Array,
): { speedMps: number; angleRad: number }[] {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: { speedMps: number; angleRad: number }[] = [];
  for (let i = 0; i + 16 <= raw.byteLength; i += 16) {
    out.push({ speedMps: dv.getFloat64(i, true), angleRad: dv.getFloat64(i + 8, true) });
  }
  return out;
}

export const TOPICS = {
  pose: '/Pose/robotPose', // double[3] {x m, y m, deg}, blue-origin
  moduleStates: '/DriveState/ModuleStates', // struct:SwerveModuleState[] raw
  moduleTargets: '/DriveState/ModuleTargets', // struct:SwerveModuleState[] raw (CTRE commanded states)
  isRedAlliance: '/FMSInfo/IsRedAlliance',
  stationNumber: '/FMSInfo/StationNumber',
  fmsControl: '/FMSInfo/FMSControlData', // int control word: 0x10 = FMS attached, 0x20 = DS attached
  autoChooser: '/SmartDashboard/Auto Chooser', // subkeys /options /default /active /selected
  telemetry: '/CompanionTelemetry', // subkeys /names /stator /supply /temp /voltage
  limelight: '/limelight-knight', // subkeys /tv /tl /cl /hb /botpose
} as const;

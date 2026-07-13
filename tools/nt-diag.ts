// NT diagnostics capture CLI — grabs live NetworkTables data from the robot (or sim)
// into a JSON file so diagnostics can be reviewed from a terminal (Claude, scripts,
// humans) without the companion app. Reuses the app's vendored NT4 client; the data
// source is the robot's NT server — the same place the app's panels read from.
//
//   node dist/nt-diag.cjs [--host 10.97.4.2] [--secs 5] [--prefix /] [--out cap.json]
//
//   --host    NT server: robot 10.97.4.2 (default), sim 127.0.0.1
//   --secs    capture duration in seconds (default 5)
//   --prefix  topic prefix filter, e.g. /CompanionTelemetry (default / = everything)
//   --out     write JSON here (default stdout; progress goes to stderr)
//
// Exit 0 = captured; exit 1 = never connected within the window (robot unreachable).
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { NT4_Client, type NT4_Topic } from '../src/renderer/vendor/NT4';
import { decodeSwerveModuleStates } from '../src/renderer/nt';

const { values: opts } = parseArgs({
  options: {
    host: { type: 'string', default: '10.97.4.2' },
    secs: { type: 'string', default: '5' },
    prefix: { type: 'string', default: '/' },
    out: { type: 'string' },
  },
});
const secs = Number(opts.secs);

type Series = { type: string; samples: [number, unknown][] };
const topics = new Map<string, Series>();
let firstTsUs: number | null = null;
let connected = false;

// Raw buffers aren't JSON-friendly: decode the one struct we know, size-stamp the rest.
function jsonable(value: unknown, type: string): unknown {
  if (value instanceof Uint8Array) {
    if (type.startsWith('struct:SwerveModuleState')) return decodeSwerveModuleStates(value);
    return { rawBytes: value.byteLength };
  }
  return value;
}

const client = new NT4_Client(
  opts.host!,
  [5810],
  'HeliosDiag',
  () => {}, // onTopicAnnounce
  () => {}, // onTopicUnannounce
  () => {}, // onTopicPropertiesUpdate
  (topic: NT4_Topic, tsUs: number, value: unknown) => {
    if (firstTsUs === null) firstTsUs = tsUs;
    let s = topics.get(topic.name);
    if (!s) {
      s = { type: topic.type, samples: [] };
      topics.set(topic.name, s);
    }
    // seconds relative to first sample, ms precision — enough for 10-50 Hz telemetry
    s.samples.push([Math.round((tsUs - firstTsUs) / 1000) / 1000, jsonable(value, topic.type)]);
  },
  () => {
    connected = true;
    console.error(`[diag] connected to ${opts.host}`);
  },
  () => console.error('[diag] disconnected'),
);

// prefix mode + sendAll at 50 Hz: every published sample, not a decimated view.
client.subscribe([opts.prefix!], true, true, 0.02);
client.connect();
console.error(`[diag] capturing '${opts.prefix}' from ${opts.host} for ${secs}s ...`);

setTimeout(() => {
  client.disconnect();
  const result = {
    host: opts.host,
    prefix: opts.prefix,
    secs,
    connected,
    topicCount: topics.size,
    topics: Object.fromEntries(
      [...topics].map(([name, s]) => [name, { type: s.type, n: s.samples.length, samples: s.samples }]),
    ),
  };
  // bigint guard: msgpack may hand back int64 as BigInt, which JSON.stringify rejects
  const json = JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1);
  if (opts.out) {
    writeFileSync(opts.out, json);
    console.error(`[diag] wrote ${opts.out} (${topics.size} topics)`);
  } else {
    console.log(json);
  }
  process.exit(connected ? 0 : 1);
}, secs * 1000);

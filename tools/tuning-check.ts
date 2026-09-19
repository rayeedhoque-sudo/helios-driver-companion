// Self-check for the SubsystemConstants.java patcher (src/main/tuning.ts). Run: npm run check
//
// This is the one piece of app logic that REWRITES the robot's configuration file, so it gets a
// check even though the app has no test framework. Pure string in / string out — it never
// touches a real file. It does read the live SubsystemConstants.java as a fixture, so it fails
// if a constant the PID panel writes is renamed or removed on the robot side.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { patchConstants, formatJavaDouble } from '../src/main/tuning';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (!cond) {
    console.error('FAIL: ' + label);
    failures++;
  }
}

// ---- formatJavaDouble --------------------------------------------------------
check('integers stay double literals', formatJavaDouble(5) === '5.0');
check('trims NT round-trip noise', formatJavaDouble(0.12625000000000003) === '0.12625');
check('keeps real precision', formatJavaDouble(0.35) === '0.35');
check('negatives survive', formatJavaDouble(-1.5) === '-1.5');
check('no scientific notation', !formatJavaDouble(0.0000001).includes('e'));

// ---- patchConstants against a synthetic fixture -------------------------------
const fixture = [
  'public class SubsystemConstants {',
  '        public static class ShooterSubsystemConstants{',
  '                public static double SHOOTER_ANGLE_kP = 0.35;',
  '                public static double SHOOTER_SPEED_kV = 0.12625;',
  '                public static double HOOD_MAX_UP_VOLTAGE = 8.0;   // raising (fights gravity)',
  '                public static final double LOCKED = 1.0;',
  '        }',
  '}',
].join('\n');

{
  const { text, changed, skipped } = patchConstants(fixture, { SHOOTER_ANGLE_kP: 0.8 });
  check('rewrites the value', text.includes('public static double SHOOTER_ANGLE_kP = 0.8;'));
  check('preserves indentation', text.includes('                public static double SHOOTER_ANGLE_kP'));
  check('reports the old value', changed.length === 1 && changed[0].from === '0.35');
  check('leaves other lines alone', text.includes('SHOOTER_SPEED_kV = 0.12625;'));
  check('no spurious skips', skipped.length === 0);
}

{
  // A trailing comment is part of the line's meaning — losing it loses tuning history.
  const { text } = patchConstants(fixture, { HOOD_MAX_UP_VOLTAGE: 8.5 });
  check(
    'preserves trailing comments',
    text.includes('public static double HOOD_MAX_UP_VOLTAGE = 8.5;   // raising (fights gravity)'),
  );
}

{
  const { text, changed, skipped } = patchConstants(fixture, { NOT_A_REAL_CONSTANT: 1 });
  check('unknown constant is skipped, not inserted', changed.length === 0 && text === fixture);
  check('and the reason is reported', skipped.length === 1 && skipped[0].reason.includes('no `public static double`'));
}

{
  // `final` constants are hardware facts, not tunables — must never be rewritten.
  const { changed, text } = patchConstants(fixture, { LOCKED: 99 });
  check('never touches a `final` constant', changed.length === 0 && text === fixture);
}

{
  const { changed, skipped } = patchConstants(fixture, { SHOOTER_ANGLE_kP: Number.NaN });
  check('rejects a non-finite value', changed.length === 0 && skipped[0].reason.includes('finite'));
}

{
  // The name is interpolated into a RegExp — a name with regex metacharacters must be refused,
  // never compiled.
  const { changed, skipped } = patchConstants(fixture, { 'A.*': 1 });
  check('rejects a non-identifier name', changed.length === 0 && skipped[0].reason.includes('identifier'));
}

{
  const dup = fixture + '\n        public static double SHOOTER_ANGLE_kP = 0.1;';
  const { changed, skipped, text } = patchConstants(dup, { SHOOTER_ANGLE_kP: 0.8 });
  check('refuses an ambiguous duplicate rather than guessing', changed.length === 0 && text === dup);
  check('and says why', skipped.length === 1 && skipped[0].reason.includes('ambiguous'));
}

{
  const { changed, skipped } = patchConstants(fixture, { SHOOTER_ANGLE_kP: 0.35 });
  check('a no-op value is not reported as a change', changed.length === 0);
  check('it is reported as already-correct', skipped[0].reason === 'already at this value');
}

// ---- against the REAL file: every constant the panel writes must exist, exactly once ----
const real = readFileSync(
  path.join(__dirname, '..', '..', 'src', 'main', 'java', 'frc', 'robot', 'Constants', 'SubsystemConstants.java'),
  'utf8',
);
// Mirrors CONSTANT_NAMES in src/renderer/pidtune.ts. If a rename breaks that map, this fails
// here instead of silently writing nothing during a tuning session.
const PANEL_CONSTANTS = [
  'SHOOTER_SPEED_kP', 'SHOOTER_SPEED_kI', 'SHOOTER_SPEED_kD',
  'SHOOTER_SPEED_kS', 'SHOOTER_SPEED_kV', 'SHOOTER_SPEED_kA',
  'SHOOTER_ANGLE_kP', 'SHOOTER_ANGLE_kI', 'SHOOTER_ANGLE_kD',
  'HEADING_kP', 'HEADING_kI', 'HEADING_kD',
];
for (const name of PANEL_CONSTANTS) {
  // Patch to a value nothing is currently set to, so "already at this value" can't mask a miss.
  const { changed, skipped } = patchConstants(real, { [name]: -12345.5 });
  check(
    'real file: ' + name + ' is writable (' + (skipped[0]?.reason ?? 'ok') + ')',
    changed.length === 1,
  );
}

if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('tuning-check: all checks passed (' + PANEL_CONSTANTS.length + ' constants verified against the real file)');
process.exit(0);

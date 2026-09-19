// Save tuned PID gains into the robot project's SubsystemConstants.java.
//
// The PID panel tunes over NetworkTables, which is VOLATILE — a robot reboot re-seeds every
// gain from the compiled constants. This is the "bake it in" half: patch the source so the
// tuned number becomes the default from the next deploy onward. It does NOT deploy, and it
// does NOT change the running robot (that already happened over NT) — it only edits the file.
//
// Safety model, in the same spirit as deploy.ts: the renderer never supplies a path. It sends
// a project KEY ('v1') validated against deploy.ts's hardcoded PROJECT_DIRS, plus a map of
// {constantName: number}. Both halves are validated here:
//   - the name must be a plain Java identifier AND must already exist in the file as a
//     `public static double NAME = ...;` declaration. We only ever REPLACE the number in an
//     existing declaration, never insert text, so there is nothing to inject.
//   - the value must be a finite number, and it is re-formatted by us before it is written.
// A name that is missing, or that appears more than once (ambiguous), is skipped and reported
// rather than guessed at.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { projectDirFor, type DeployTarget } from './deploy';

const CONSTANTS_REL = path.join('src', 'main', 'java', 'frc', 'robot', 'Constants', 'SubsystemConstants.java');

// Java identifier — no dots, no whitespace, nothing that could escape the regex we build.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SaveResult {
  ok: boolean;
  file: string;
  /** Constants actually rewritten, with what they were. */
  changed: { name: string; from: string; to: string }[];
  /** Constants left alone, and why (already correct / not found / ambiguous / bad value). */
  skipped: { name: string; reason: string }[];
  error?: string;
}

/**
 * Rewrite the numeric initializer of each named `public static double` constant.
 *
 * Exported for the self-check in tools/tuning-check.ts — keep it pure (string in, string out)
 * so the patching logic can be tested without touching a real file.
 */
export function patchConstants(
  source: string,
  gains: Record<string, number>,
): { text: string; changed: SaveResult['changed']; skipped: SaveResult['skipped'] } {
  const changed: SaveResult['changed'] = [];
  const skipped: SaveResult['skipped'] = [];
  let text = source;

  for (const [name, value] of Object.entries(gains)) {
    if (!NAME_RE.test(name)) {
      skipped.push({ name, reason: 'not a Java identifier' });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      skipped.push({ name, reason: 'value is not a finite number' });
      continue;
    }
    // Anchored on `public static double NAME =` so this can only ever hit a DECLARATION —
    // never an assignment like `shooterVelConfigs.kP = ...`. Groups: 1 = everything up to and
    // including the '=', 2 = the initializer, 3 = ';' plus any trailing comment (preserved).
    const re = new RegExp(`^([ \\t]*public\\s+static\\s+double\\s+${name}\\s*=\\s*)([^;]*?)(\\s*;.*)$`, 'gm');
    const matches = text.match(re);
    if (!matches || matches.length === 0) {
      skipped.push({ name, reason: 'no `public static double` declaration found' });
      continue;
    }
    if (matches.length > 1) {
      // Two declarations of the same name (different nested classes) — we cannot tell which
      // one the gain came from, and picking wrong writes a tuned number into the wrong
      // mechanism. Refuse rather than guess.
      skipped.push({ name, reason: `${matches.length} declarations found — ambiguous` });
      continue;
    }

    const literal = formatJavaDouble(value);
    let from = '';
    text = text.replace(re, (_m, head: string, old: string, tail: string) => {
      from = old.trim();
      return head + literal + tail;
    });
    if (from === literal) {
      skipped.push({ name, reason: 'already at this value' });
      continue;
    }
    changed.push({ name, from, to: literal });
  }

  return { text, changed, skipped };
}

/** Match the repo's style: plain decimals, and never scientific notation in source. */
export function formatJavaDouble(v: number): string {
  // toPrecision(12) drops NT round-trip noise (0.12625000000000003 -> 0.12625) without
  // rounding away a value anyone would actually type.
  const n = Number(v.toPrecision(12));
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toFixed(1); // 5 -> "5.0", stays a double literal
  const s = String(n);
  return s.includes('e') || s.includes('E') ? n.toFixed(10).replace(/0+$/, '') : s;
}

export function saveGains(target: DeployTarget | undefined, gains: Record<string, number>): SaveResult {
  const file = path.join(projectDirFor(target), CONSTANTS_REL);
  const empty: SaveResult = { ok: false, file, changed: [], skipped: [] };

  if (!gains || typeof gains !== 'object') {
    return { ...empty, error: 'no gains supplied' };
  }
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    return { ...empty, error: `could not read ${file}: ${(err as Error).message}` };
  }

  const { text, changed, skipped } = patchConstants(source, gains);
  if (changed.length === 0) {
    return { ok: true, file, changed, skipped }; // nothing to write — don't touch the file
  }

  try {
    // Write-temp-then-rename, same as settings: a crash mid-write must never leave
    // SubsystemConstants.java truncated. This file is the robot's entire configuration.
    const tmp = file + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    return { ...empty, skipped, error: `could not write ${file}: ${(err as Error).message}` };
  }
  return { ok: true, file, changed, skipped };
}

// Deploy: spawns `gradlew.bat deploy` for the robot project and streams its
// output to the renderer. Exported functions are called from main.ts's IPC
// handlers + before-quit hook — child-process logic stays here, not in
// main.ts (see ARCHITECTURE.md "Deploy (main) + IPC").
//
// Spawn is a FIXED argv (`cmd.exe /c gradlew.bat deploy`, cwd = the robot
// project, shell:false). The renderer's project dropdown sends only a KEY
// ('v1') that is validated against the PROJECT_DIRS map below — the cwd
// and gradlew path are still built from HARDCODED constants, never from user
// free-text, so there is still nothing to sanitize in the command. Deliberately
// not templated to keep it that way. Single-flight: only one run at a time (see
// startDeploy). Cancel/quit kill the whole process TREE via `taskkill /T /F` —
// gradle spawns a daemon JVM (and that spawns build children) that `cmd.exe /c`
// does not track as its own child, so a plain child.kill() would leave them running.
import { spawn, execFile, type ChildProcess } from 'node:child_process';

// Deploy targets: a FIXED map of allowed project keys -> hardcoded absolute
// project dirs. V1 is the only project now — the V2 re-architecture tree was
// deleted 2026-08-27. The map/key indirection stays so an unknown IPC key still
// falls back to V1 rather than reaching spawn as a path.
export type DeployTarget = 'v1';
const PROJECT_DIRS: Record<DeployTarget, string> = {
  v1: 'C:\\FRC\\Helios-2026',
};
export const DEFAULT_TARGET: DeployTarget = 'v1';
// Resolve a key to its hardcoded path, falling back to the default for any
// unknown/absent key (so a bad IPC payload can never reach spawn as a path).
export function projectDirFor(target: DeployTarget | undefined): string {
  return (target && PROJECT_DIRS[target]) || PROJECT_DIRS[DEFAULT_TARGET];
}

export type DeployPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled';
export type DeployStatus = { phase: DeployPhase; startedAt: number | null; exitCode: number | null };
export type DeployActionResult = { ok: true } | { ok: false; error: string };

let child: ChildProcess | null = null;
let phase: DeployPhase = 'idle';
let startedAt: number | null = null;
let exitCode: number | null = null;
let onOutput: ((chunk: string) => void) | null = null;
let onDone: ((code: number | null) => void) | null = null;

// Registers the push callbacks main.ts uses to forward events to the renderer
// (webContents.send). Call once at window creation — same pattern as initDsDock.
export function initDeploy(output: (chunk: string) => void, done: (code: number | null) => void): void {
  onOutput = output;
  onDone = done;
}

export function getStatus(): DeployStatus {
  return { phase, startedAt, exitCode };
}

export function startDeploy(target: DeployTarget = DEFAULT_TARGET): DeployActionResult {
  if (phase === 'running') return { ok: false, error: 'a deploy is already running' };

  const projectDir = projectDirFor(target);
  // Absolute path, not a bare 'gradlew.bat' — this machine has the Windows
  // hardening env var NoDefaultCurrentDirectoryInExePath=1 set, which disables
  // cmd.exe's implicit search of the current directory for an executable, so a
  // bare filename silently fails to resolve even with the right cwd. Built from
  // the hardcoded PROJECT_DIRS constant, nothing user-controllable.
  const gradlew = projectDir + '\\gradlew.bat';

  phase = 'running';
  startedAt = Date.now();
  exitCode = null;

  // --no-daemon: the build must run IN this process tree. A gradle daemon (its own
  // detached JVM, possibly pre-existing from VS Code builds) keeps building/deploying
  // after `taskkill /T` kills the client — Cancel would not actually cancel, and a
  // half-cancelled deploy could still land on the robot. Costs a few seconds of JVM
  // startup per deploy; correctness of Cancel wins.
  child = spawn('cmd.exe', ['/c', gradlew, 'deploy', '--no-daemon'], {
    cwd: projectDir,
    shell: false,
    windowsHide: true, // cosmetic only — no console-window flash; argv/cwd unaffected
  });

  child.stdout?.on('data', (buf: Buffer) => onOutput?.(buf.toString('utf8')));
  child.stderr?.on('data', (buf: Buffer) => onOutput?.(buf.toString('utf8')));

  child.on('close', (code) => {
    exitCode = code;
    // A cancel already set 'cancelled' — don't overwrite it with the killed
    // process's exit code.
    if (phase === 'running') phase = code === 0 ? 'success' : 'failed';
    child = null;
    onDone?.(code);
  });
  child.on('error', (err) => {
    onOutput?.(`[deploy] failed to launch: ${err.message}\n`);
    phase = 'failed';
    exitCode = null;
    child = null;
    onDone?.(null);
  });

  return { ok: true };
}

export function cancelDeploy(): Promise<DeployActionResult> {
  if (phase !== 'running' || !child || child.pid == null) {
    return Promise.resolve({ ok: false, error: 'no deploy is running' });
  }
  const pid = child.pid;
  phase = 'cancelled';
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve({ ok: true }));
  });
}

// Best-effort cleanup on app quit (wired additively into main.ts's existing
// before-quit path). Fire-and-forget — quit must not wait on it.
export function killDeployOnQuit(): void {
  if (!child || child.pid == null) return;
  const pid = child.pid;
  try {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    // never throw on an exit path
  }
}

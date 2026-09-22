/**
 * Command-spawning primitives shared by the Effect-native
 * {@link import('./execUtils').executeCommand} and its synchronous companion:
 * environment and encoding normalization, `ExecResult` construction, process
 * -group signalling, and `executeCommandSync` itself.
 *
 * These live beside `execUtils.ts` rather than inside it because they are the
 * pieces that must stay `try`/`catch`-shaped: a synchronous spawn has no Effect
 * to fail into, and `execUtils.ts` — which imports `effect` at runtime — is held
 * to zero raw catch clauses by the `catch:effect-importer` ratchet row.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import {
  execaSync,
  type Options,
  type StdoutStderrOption,
  type SyncOptions,
  ExecaError,
} from 'execa';
import { quote as shellQuote } from 'shell-quote';
import treeKill from 'tree-kill';

// Internal imports
import { createLog } from '@logger/logUtils';
import type { ExecResult } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { IS_WINDOWS, withExtendedPath } from '@utils/system/platformPaths';

export const CHANNEL = 'execUtils';

export type ExecaTextEncoding = Extract<
  NonNullable<Options['encoding']>,
  'utf8' | 'utf16le'
>;
export type ExecEncoding = ExecaTextEncoding | 'utf-8';
export type ExecOutput = Extract<StdoutStderrOption, string>;

const MAX_OUTPUT_LENGTH = 150;

/** Channel-bound logger view (see `createLog` in `@logger/logUtils`). */
export type Log = ReturnType<typeof createLog>;

function normalizeOutput(text: string | null | undefined): string {
  return text?.trim() ?? '';
}

/**
 * Prefer captured stderr; fall back to execa's `shortMessage` only when
 * stderr is empty and the result looks abnormal (caller-defined: max-buffer
 * trip, missing exit code, timeout, ...). Shared by every execa result
 * normalizer in the codebase so this fallback rule only exists once.
 */
export function deriveCommandStderr(
  stderr: string,
  shortMessage: string | undefined,
  looksAbnormal: boolean,
): string {
  return stderr || (looksAbnormal ? (shortMessage ?? '') : '');
}

/** Normalize Node's 'utf-8' alias to execa's 'utf8' encoding option. */
export function normalizeEncoding(
  encoding: ExecEncoding = 'utf8',
): ExecaTextEncoding {
  return encoding === 'utf-8' ? 'utf8' : encoding;
}

export function commandEnv(
  workspacePath: string,
  authorEnv: Record<string, string | undefined> | undefined,
  envOverrides?: Record<string, string>,
): Record<string, string | undefined> {
  // withExtendedPath, not a bare `env.PATH =`: on Windows the copy of
  // `process.env` carries the variable as `Path`, so assigning `PATH` would
  // leave both spellings on the environment handed to the shell — and the one
  // the shell actually resolves against is then undefined.
  const env = withExtendedPath({
    ...process.env,
    ...authorEnv,
    ...envOverrides,
  });

  // Export project context so AI agents can orient themselves immediately.
  env.PROJECT_DIR = workspacePath;
  env.PROJECT_NAME = path.basename(workspacePath);
  return env;
}

export function resultFromProcessOutput(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  exitCode: number,
  flags: { timedOut?: boolean; outputLimitExceeded?: boolean } = {},
): ExecResult {
  const timedOut = flags.timedOut ?? false;
  return {
    success: exitCode === 0 && !timedOut && !flags.outputLimitExceeded,
    stdout: normalizeOutput(stdout),
    stderr: normalizeOutput(stderr),
    timedOut,
    exitCode,
    ...(flags.outputLimitExceeded ? { outputLimitExceeded: true } : {}),
  };
}

function resultFromExecutionError(err: unknown): ExecResult {
  if (err instanceof ExecaError) {
    const outputLimitExceeded = err.isMaxBuffer ?? false;
    return {
      success: false,
      stdout: normalizeOutput(`${err.stdout ?? ''}`),
      stderr: normalizeOutput(`${err.stderr || toErrorMessage(err)}`),
      timedOut: err.timedOut ?? false,
      exitCode: outputLimitExceeded ? 2 : (err.exitCode ?? 127),
      ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
    };
  }

  return {
    success: false,
    stdout: '',
    stderr: normalizeOutput(toErrorMessage(err)),
    timedOut: false,
    exitCode: 127,
  };
}

export function logExecutionErrorAndBuildResult(
  err: unknown,
  options: { quiet?: boolean; channel?: string },
): ExecResult {
  if (!options.quiet) {
    createLog(options.channel ?? CHANNEL).error(
      `Error executing command: ${toErrorMessage(err)}`,
    );
  }
  return resultFromExecutionError(err);
}

export function logCommandStderr(
  log: Log,
  stderr: string | null | undefined,
  truncate = false,
): void {
  const normalizedStderr = normalizeOutput(stderr);
  if (!normalizedStderr) return;

  const stderrForLog =
    truncate && normalizedStderr.length > MAX_OUTPUT_LENGTH
      ? `...${normalizedStderr.slice(-MAX_OUTPUT_LENGTH)}`
      : normalizedStderr;
  log.debug(`Command stderr: ${stderrForLog}`);
}

/**
 * Signal a process and all of its descendants.
 *
 * Two platform strategies, each picking the most reliable mechanism:
 *
 * - **Windows** has no process-group signalling, so a bare `process.kill(pid)`
 *   only hit the shell and left piped children (e.g. `find | head`) running
 *   with stdout still open, hanging the awaited subprocess. We delegate to
 *   `tree-kill`, which shells out to `taskkill /T /F` to tear down the whole
 *   process tree — closing that long-standing orphaned-children gap.
 *
 * - **POSIX** signals the whole process group via the negative PID. Callers
 *   that need teardown spawn the shell `detached` (a new group leader), so the
 *   group kill reaches backgrounded children (`cmd &`) directly and
 *   synchronously. Group membership is stronger than a parent/child (`ps
 *   --ppid`) walk here: it survives re-parenting and double-forks that a tree
 *   walk would miss. Falls back to the bare PID when the target isn't a group
 *   leader.
 *
 * Best-effort and fire-and-forget — a process that already exited is a no-op,
 * matching the previous contract where every caller ignored the result.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    treeKill(pid, signal, (error) => {
      if (error) {
        createLog(CHANNEL).debug(
          `tree-kill failed for pid ${pid} (${signal}): ${toErrorMessage(error)}`,
        );
      }
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited — nothing to signal.
    }
  }
}

/**
 * Synchronous companion to `executeCommand` for APIs that must return a value
 * synchronously, such as native binary resolvers passed to SDK constructors.
 * `cwd` is required, like `executeCommand`'s; prefer `executeCommand` for
 * normal workspace command runs.
 */
export function executeCommandSync(
  command: readonly [string, ...string[]],
  options: {
    encoding?: ExecEncoding;
    channel?: string;
    truncate?: boolean;
    env?: Record<string, string>;
    timeout?: number;
    /** See `ExecuteCommandBaseOptions.cwd`. */
    cwd: string;
    /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
    quiet?: boolean;
  },
): ExecResult {
  try {
    const [cmd, ...args] = command;
    const workspacePath = options.cwd;
    const execaOptions: SyncOptions = {
      cwd: workspacePath,
      env: commandEnv(workspacePath, undefined, options.env),
      encoding: normalizeEncoding(options.encoding),
      timeout: options.timeout,
      reject: false,
    };
    const log = createLog(options.channel ?? CHANNEL);
    if (!options.quiet) {
      log.debug(`Running command: ${shellQuote(command)}`);
    }
    const result = execaSync(cmd, args, execaOptions);
    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    const exitCode = result.exitCode ?? 1;
    const timedOut = result.timedOut ?? false;

    if (!options.quiet) {
      logCommandStderr(log, stderr, options.truncate);
    }

    return resultFromProcessOutput(stdout, stderr, exitCode, { timedOut });
  } catch (err) {
    return logExecutionErrorAndBuildResult(err, options);
  }
}

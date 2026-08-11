// Third-party imports
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  execa,
  execaSync,
  type Options,
  type ResultPromise,
  ExecaError,
  type StdoutStderrOption,
  type SyncOptions,
} from 'execa';
import { quote as shellQuote } from 'shell-quote';
import treeKill from 'tree-kill';

// Internal imports
import * as logger from '@logger/logUtils';
import type { ExecResult } from '@shared/schemas/opResults';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getGitAuthorEnv } from '@utils/system/gitAuthorEnv';
import { IS_WINDOWS, extendEnvPath } from '@utils/system/platformPaths';

const CHANNEL = 'execUtils';

type ExecaTextEncoding = Extract<
  NonNullable<Options['encoding']>,
  'utf8' | 'utf16le'
>;
type ExecEncoding = ExecaTextEncoding | 'utf-8';
type ExecOutput = Extract<StdoutStderrOption, string>;

const MAX_OUTPUT_LENGTH = 150;
const FORCE_KILL_DELAY_MS = 5_000;

function normalizeOutput(text: string | null | undefined): string | null {
  return text?.trim() || null;
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
function normalizeEncoding(encoding: ExecEncoding = 'utf8'): ExecaTextEncoding {
  return encoding === 'utf-8' ? 'utf8' : encoding;
}

function subscribeDecodedOutput(
  stream: NodeJS.ReadableStream,
  encoding: ExecaTextEncoding,
  onOutput: (chunk: string) => void,
): void {
  const decoder = new StringDecoder(encoding);
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    const text = decoder.end();
    if (text) onOutput(text);
  };

  stream.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (text) onOutput(text);
  });
  stream.once('end', finalize);
  stream.once('close', finalize);
}

function commandEnv(
  workspacePath: string,
  envOverrides?: Record<string, string>,
): Record<string, string | undefined> {
  const env = { ...process.env, ...getGitAuthorEnv(), ...envOverrides };
  env.PATH = extendEnvPath(env.PATH);

  // Export project context so AI agents can orient themselves immediately.
  env.PROJECT_DIR = workspacePath;
  env.PROJECT_NAME = path.basename(workspacePath);
  return env;
}

function resultFromProcessOutput(
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
    stdout: null,
    stderr: normalizeOutput(toErrorMessage(err)),
    timedOut: false,
    exitCode: 127,
  };
}

function logExecutionErrorAndBuildResult(
  err: unknown,
  options: { quiet?: boolean; channel?: string },
): ExecResult {
  if (!options.quiet) {
    logger.error(
      options.channel ?? CHANNEL,
      `Error executing command: ${toErrorMessage(err)}`,
    );
  }
  return resultFromExecutionError(err);
}

function logCommandStderr(
  channel: string,
  stderr: string | null | undefined,
  truncate = false,
): void {
  const normalizedStderr = normalizeOutput(stderr);
  if (!normalizedStderr) return;

  const stderrForLog =
    truncate && normalizedStderr.length > MAX_OUTPUT_LENGTH
      ? `...${normalizedStderr.slice(-MAX_OUTPUT_LENGTH)}`
      : normalizedStderr;
  logger.debug(channel, `Command stderr: ${stderrForLog}`);
}

function workspacePathOrProcessCwd(): string {
  try {
    return WorkspaceFS.getPath() ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * Signal a process and all of its descendants.
 *
 * Two platform strategies, each picking the most reliable mechanism:
 *
 * - **Windows** has no process-group signalling, so a bare `process.kill(pid)`
 *   only hit the shell and left piped children (e.g. `find | head`) running
 *   with stdout still open, hanging `await subprocess`. We delegate to
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
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    treeKill(pid, signal, (error) => {
      if (error) {
        logger.debug(
          CHANNEL,
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
 * Execute external command with output handling and workspace path management.
 */
export async function executeCommand(
  command: string | string[],
  options: {
    encoding?: ExecEncoding;
    channel?: string;
    truncate?: boolean;
    env?: Record<string, string>;
    timeout?: number;
    cwd?: string;
    stdin?: string;
    /** Called with stdout chunks as they arrive, enabling live output streaming. */
    onStdout?: (chunk: string) => void;
    /** Called with stderr chunks as they arrive, enabling live error streaming. */
    onStderr?: (chunk: string) => void;
    /** Called with subprocess PID right after creation, before awaiting. */
    onPid?: (pid: number) => void;
    /** Set to false to skip buffering stdout/stderr in memory (use with onStdout/onStderr). */
    buffer?: boolean;
    /** Maximum decoded characters execa may retain per output stream before terminating the process. */
    maxBuffer?: number;
    stdout?: ExecOutput;
    stderr?: ExecOutput;
    /** Abort signal used to terminate the subprocess and any shell children. */
    signal?: AbortSignal;
    /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
    quiet?: boolean;
  } = {},
): Promise<ExecResult> {
  // Hoisted so the finally block can clear them on both success and error paths.
  let shellTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    if (options.signal?.aborted) {
      return resultFromProcessOutput(null, 'Command aborted by user', 130);
    }

    const workspacePath = options.cwd ?? WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const env = commandEnv(workspacePath, options.env);
    const encoding = normalizeEncoding(options.encoding);

    const execaOptions: Options = {
      cwd: workspacePath,
      env,
      encoding,
      timeout: options.timeout,
      reject: false,
      input: options.stdin,
      buffer: options.buffer,
      maxBuffer: options.maxBuffer,
      stdout: options.stdout,
      stderr: options.stderr,
    };

    const logChannel = options.channel ?? CHANNEL;

    let subprocess: ResultPromise;
    let shellTimedOut = false;
    let shellAborted = false;

    // Only the shell/string form needs this hand-rolled abort + force-kill
    // machinery: it terminates via `signalProcessGroup` (negative-PID /
    // tree-kill) so piped children don't outlive the shell. The array form
    // spawns a single non-detached process and leaves all signalling to
    // execa's own `cancelSignal` / `forceKillAfterDelay` natives below; its
    // only hand-rolled piece is the signal-free stream-destroy backstop
    // armed for abort and timeout teardown.
    const terminateSubprocess = (signal: NodeJS.Signals): void => {
      const pid = subprocess.pid;
      if (!pid) return;

      signalProcessGroup(pid, signal);

      // Force-kill after FORCE_KILL_DELAY_MS if SIGTERM didn't work,
      // and destroy streams as a last resort to unblock `await subprocess`.
      if (signal === 'SIGTERM' && forceKillTimeoutId === undefined) {
        forceKillTimeoutId = setTimeout(() => {
          signalProcessGroup(pid, 'SIGKILL');
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
        }, FORCE_KILL_DELAY_MS);
      }
    };

    const installAbortListener = (
      onAbort: () => void,
      armOnTimeout = false,
    ): void => {
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          options.signal?.removeEventListener('abort', onAbort);
        };
        if (options.signal.aborted) onAbort();
      }
      if (armOnTimeout && options.timeout !== undefined) {
        shellTimeoutId = setTimeout(onAbort, options.timeout);
      }
    };

    let shellTimeout: number | undefined;
    if (Array.isArray(command)) {
      const [cmd, ...args] = command;
      if (!options.quiet) {
        logger.debug(
          logChannel,
          `Running command: ${shellQuote([cmd, ...args])}`,
        );
      }
      subprocess = execa(cmd, args, {
        ...execaOptions,
        cancelSignal: options.signal,
        forceKillAfterDelay: FORCE_KILL_DELAY_MS,
      });
    } else {
      if (!options.quiet) {
        logger.debug(logChannel, `Running command: ${command}`);
      }
      // Shell commands with pipes (e.g. "find / | head -2") create child
      // processes that inherit stdout.  execa's built-in timeout only kills
      // the shell process; the piped children keep stdout open which causes
      // `await subprocess` to hang indefinitely.
      //
      // Fix: when a timeout is configured, spawn in a new process group
      // (detached) and manually kill the entire group (-pid) on timeout so
      // all children are terminated.  Without a timeout we use the normal
      // (non-detached) path to avoid orphan risk on parent crash.
      //
      // On Windows, negative-PID signaling is not supported so we fall back
      // to subprocess.kill() (kills the shell only) + stream destruction.
      //
      // Tradeoff: `detached` means the process group is NOT automatically
      // cleaned up if the extension host is hard-killed (SIGKILL / crash) --
      // long-running shell commands would be orphaned. This only affects
      // shell-form commands that opt into timeout/cancel handling, primarily
      // the bash tool. Acceptable because the alternative is `await` hanging
      // forever or leaving approved children running after a user stop.
      const { timeout, ...execaNoTimeout } = execaOptions;
      shellTimeout = timeout;
      // Only use detached when we have a timeout/signal and need process-group killing.
      // On POSIX, detached creates a process group we can kill as a unit.
      // On Windows, detached opens a new console window so we always skip it.
      const useDetached = (!!shellTimeout || !!options.signal) && !IS_WINDOWS;
      subprocess = execa(command, {
        ...execaNoTimeout,
        shell: true,
        ...(useDetached ? { detached: true } : {}),
      });
    }

    if (subprocess.pid && options.onPid) options.onPid(subprocess.pid);
    if (Array.isArray(command)) {
      // Array-form abort/force-kill is execa's (`cancelSignal` /
      // `forceKillAfterDelay` above), but execa only signals the tracked
      // pid: a descendant that inherited stdio (e.g. `bash -c 'work &
      // wait'`) can keep the pipes open after the tracked process dies,
      // hanging `await subprocess` forever. Destroy the streams once
      // execa's force-kill delay has elapsed so the await always unblocks.
      // No signal is sent here — the array form intentionally keeps no
      // process-group semantics, so the descendant itself is left alone.
      installAbortListener(() => {
        if (forceKillTimeoutId !== undefined) return;
        forceKillTimeoutId = setTimeout(() => {
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
        }, FORCE_KILL_DELAY_MS);
      }, true);
    } else {
      installAbortListener(() => {
        shellAborted = true;
        terminateSubprocess('SIGTERM');
      });
    }

    if (shellTimeout) {
      shellTimeoutId = setTimeout(() => {
        shellTimedOut = true;
        terminateSubprocess('SIGTERM');
      }, shellTimeout);
    }

    // Subscribe to stdout/stderr streams for live output if callbacks provided
    if (options.onStdout && subprocess.stdout) {
      subscribeDecodedOutput(subprocess.stdout, encoding, options.onStdout);
    }
    if (options.onStderr && subprocess.stderr) {
      subscribeDecodedOutput(subprocess.stderr, encoding, options.onStderr);
    }

    const result = await subprocess;

    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    // `shellAborted` covers the hand-rolled shell-form path; `isCanceled`
    // covers the array-form path, aborted natively via execa's `cancelSignal`.
    const aborted = shellAborted || (result.isCanceled ?? false);
    const maxBufferExceeded = result.isMaxBuffer ?? false;
    const exitCode = maxBufferExceeded
      ? 2
      : (result.exitCode ?? (aborted ? 130 : 1));
    const timedOut = (result.timedOut ?? false) || shellTimedOut;
    const shouldUseShortMessage =
      maxBufferExceeded || result.exitCode === undefined || timedOut;
    const normalizedStderr =
      aborted && !stderr
        ? 'Command aborted by user'
        : deriveCommandStderr(
            stderr,
            result.shortMessage,
            shouldUseShortMessage,
          );

    if (!options.quiet) {
      logCommandStderr(logChannel, normalizedStderr, options.truncate);
    }

    return resultFromProcessOutput(stdout, normalizedStderr, exitCode, {
      timedOut,
      outputLimitExceeded: maxBufferExceeded,
    });
  } catch (err) {
    return logExecutionErrorAndBuildResult(err, options);
  } finally {
    if (shellTimeoutId !== undefined) clearTimeout(shellTimeoutId);
    if (forceKillTimeoutId !== undefined) clearTimeout(forceKillTimeoutId);
    removeAbortListener?.();
  }
}

/**
 * Synchronous companion to executeCommand for APIs that must return a value
 * synchronously, such as native binary resolvers passed to SDK constructors.
 * If no cwd is passed and the platform is not initialized yet, this falls back
 * to process.cwd(); prefer executeCommand for normal workspace command execution.
 */
export function executeCommandSync(
  command: readonly [string, ...string[]],
  options: {
    encoding?: ExecEncoding;
    channel?: string;
    truncate?: boolean;
    env?: Record<string, string>;
    timeout?: number;
    cwd?: string;
    /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
    quiet?: boolean;
  } = {},
): ExecResult {
  try {
    const [cmd, ...args] = command;
    const workspacePath = options.cwd ?? workspacePathOrProcessCwd();
    const execaOptions: SyncOptions = {
      cwd: workspacePath,
      env: commandEnv(workspacePath, options.env),
      encoding: normalizeEncoding(options.encoding),
      timeout: options.timeout,
      reject: false,
    };
    const logChannel = options.channel ?? CHANNEL;
    if (!options.quiet) {
      logger.debug(
        logChannel,
        `Running command: ${shellQuote([cmd, ...args])}`,
      );
    }
    const result = execaSync(cmd, args, execaOptions);
    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    const exitCode = result.exitCode ?? 1;
    const timedOut = result.timedOut ?? false;

    if (!options.quiet) {
      logCommandStderr(logChannel, stderr, options.truncate);
    }

    return resultFromProcessOutput(stdout, stderr, exitCode, { timedOut });
  } catch (err) {
    return logExecutionErrorAndBuildResult(err, options);
  }
}

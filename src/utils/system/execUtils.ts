// Third-party imports
import * as path from 'path';

import {
  execa,
  execaSync,
  type Options,
  type ResultPromise,
  ExecaError,
  type SyncOptions,
} from 'execa';
import { quote as shellQuote } from 'shell-quote';

// Local imports - log
import type { ExecResult } from '@agent/types/ResultTypes';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Internal imports
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { getGitAuthorEnv } from '@utils/system/gitAuthorEnv';
import { IS_WINDOWS, extendEnvPath } from '@utils/system/platformPaths';

const CHANNEL = 'execUtils';
logger.initialize(CHANNEL);

/**
 * Encoding options compatible with execa v9.
 * execa uses a stricter encoding type than Node's BufferEncoding.
 */
type ExecaEncodingOption =
  | 'utf8'
  | 'utf16le'
  | 'buffer'
  | 'hex'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'ascii';

const MAX_OUTPUT_LENGTH = 150;
const FORCE_KILL_DELAY_MS = 5_000;

function normalizeOutput(text: string | null | undefined): string | null {
  return text?.trim() || null;
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
  timedOut = false,
): ExecResult {
  return {
    success: exitCode === 0 && !timedOut,
    stdout: normalizeOutput(stdout),
    stderr: normalizeOutput(stderr),
    timedOut,
    exitCode,
  };
}

function resultFromExecutionError(err: unknown): ExecResult {
  if (err instanceof ExecaError) {
    return {
      success: false,
      stdout: normalizeOutput(`${err.stdout ?? ''}`),
      stderr: normalizeOutput(`${err.stderr || toErrorMessage(err)}`),
      timedOut: err.timedOut ?? false,
      exitCode: err.exitCode ?? 127,
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
 * Send a signal to a process group (POSIX) or directly to the process (Windows).
 * On POSIX, sends to the process group first (negative PID); falls back to
 * the direct PID if the group signal fails (e.g. process is not a group leader).
 * Returns true if the signal was delivered, false if the process already exited.
 */
export function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  if (IS_WINDOWS) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Execute external command with output handling and workspace path management.
 */
export async function executeCommand(
  command: string | string[],
  options: {
    outputFile?: string;
    encoding?: BufferEncoding;
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
  } = {},
): Promise<ExecResult> {
  // Hoisted so the finally block can clear them on both success and error paths.
  let shellTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const workspacePath = options.cwd ?? WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const env = commandEnv(workspacePath, options.env);

    // Normalize 'utf-8' to 'utf8' for execa compatibility
    const rawEncoding = options.encoding ?? 'utf8';
    const encodingOption: ExecaEncodingOption =
      rawEncoding.toLowerCase() === 'utf-8'
        ? 'utf8'
        : (rawEncoding as ExecaEncodingOption);

    const execaOptions: Options = {
      cwd: workspacePath,
      env,
      encoding: encodingOption,
      timeout: options.timeout,
      reject: false,
      input: options.stdin,
      buffer: options.buffer,
    };

    const logChannel = options.channel ?? CHANNEL;

    let subprocess: ResultPromise;
    let shellTimedOut = false;

    if (Array.isArray(command)) {
      const [cmd, ...args] = command;
      logger.debug(
        logChannel,
        `Running command: ${shellQuote([cmd, ...args])}`,
      );
      subprocess = execa(cmd, args, execaOptions);
      if (subprocess.pid && options.onPid) options.onPid(subprocess.pid);
    } else {
      logger.debug(logChannel, `Running command: ${command}`);
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
      // long-running shell commands would be orphaned.  This only affects the
      // bash tool (all other callers use array-form commands which skip this
      // path).  Acceptable because the alternative is `await` hanging forever.
      const { timeout: _shellTimeout, ...execaNoTimeout } = execaOptions;
      // Only use detached when we have a timeout and need process-group killing.
      // On POSIX, detached creates a process group we can kill as a unit.
      // On Windows, detached opens a new console window so we always skip it.
      const useDetached = !!_shellTimeout && !IS_WINDOWS;
      subprocess = execa(command, {
        ...execaNoTimeout,
        shell: true,
        ...(useDetached ? { detached: true } : {}),
      });
      if (subprocess.pid && options.onPid) options.onPid(subprocess.pid);

      if (_shellTimeout) {
        shellTimeoutId = setTimeout(() => {
          shellTimedOut = true;
          const pid = subprocess.pid;
          if (!pid) return;

          signalProcessGroup(pid, 'SIGTERM');

          // Force-kill after FORCE_KILL_DELAY_MS if SIGTERM didn't work,
          // and destroy streams as a last resort to unblock `await subprocess`.
          forceKillTimeoutId = setTimeout(() => {
            signalProcessGroup(pid, 'SIGKILL');
            subprocess.stdout?.destroy();
            subprocess.stderr?.destroy();
          }, FORCE_KILL_DELAY_MS);
        }, _shellTimeout);
      }
    }

    // Subscribe to stdout/stderr streams for live output if callbacks provided
    if (options.onStdout && subprocess.stdout) {
      subprocess.stdout.on('data', (chunk: Buffer | string) => {
        options.onStdout!(String(chunk));
      });
    }
    if (options.onStderr && subprocess.stderr) {
      subprocess.stderr.on('data', (chunk: Buffer | string) => {
        options.onStderr!(String(chunk));
      });
    }

    const result = await subprocess;

    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    const exitCode = result.exitCode ?? 1;
    const timedOut = (result.timedOut ?? false) || shellTimedOut;

    logCommandStderr(logChannel, stderr, options.truncate);

    return resultFromProcessOutput(stdout, stderr, exitCode, timedOut);
  } catch (err) {
    logger.error(
      options.channel ?? CHANNEL,
      `Error executing command: ${toErrorMessage(err)}`,
    );

    return resultFromExecutionError(err);
  } finally {
    if (shellTimeoutId !== undefined) clearTimeout(shellTimeoutId);
    if (forceKillTimeoutId !== undefined) clearTimeout(forceKillTimeoutId);
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
    encoding?: BufferEncoding;
    channel?: string;
    truncate?: boolean;
    env?: Record<string, string>;
    timeout?: number;
    cwd?: string;
  } = {},
): ExecResult {
  try {
    const [cmd, ...args] = command;
    const workspacePath = options.cwd ?? workspacePathOrProcessCwd();
    const rawEncoding = options.encoding ?? 'utf8';
    const encodingOption: ExecaEncodingOption =
      rawEncoding.toLowerCase() === 'utf-8'
        ? 'utf8'
        : (rawEncoding as ExecaEncodingOption);
    const execaOptions: SyncOptions = {
      cwd: workspacePath,
      env: commandEnv(workspacePath, options.env),
      encoding: encodingOption,
      timeout: options.timeout,
      reject: false,
    };
    const logChannel = options.channel ?? CHANNEL;
    logger.debug(logChannel, `Running command: ${shellQuote([cmd, ...args])}`);
    const result = execaSync(cmd, args, execaOptions);
    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    const exitCode = result.exitCode ?? 1;
    const timedOut = result.timedOut ?? false;

    logCommandStderr(logChannel, stderr, options.truncate);

    return resultFromProcessOutput(stdout, stderr, exitCode, timedOut);
  } catch (err) {
    logger.error(
      options.channel ?? CHANNEL,
      `Error executing command: ${toErrorMessage(err)}`,
    );

    return resultFromExecutionError(err);
  }
}

// Third-party imports
import { StringDecoder } from 'node:string_decoder';

import { Effect, type Scope } from 'effect';
import { execa, type Options, type ResultPromise } from 'execa';
import { quote as shellQuote } from 'shell-quote';

// Internal imports
import { createLog } from '@logger/logUtils';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { ExecResult } from '@shared/schemas';
import { onAbort as onAbortSignal } from '@utils/core';
import {
  CHANNEL,
  commandEnv,
  deriveCommandStderr,
  logCommandStderr,
  logExecutionErrorAndBuildResult,
  normalizeEncoding,
  resultFromProcessOutput,
  signalProcessGroup,
  type ExecEncoding,
  type ExecaTextEncoding,
  type ExecOutput,
} from '@utils/system/execCore';
import { IS_WINDOWS } from '@utils/system/platformPaths';

const FORCE_KILL_DELAY_MS = 5_000;

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

export interface ExecuteCommandBaseOptions {
  encoding?: ExecEncoding;
  channel?: string;
  truncate?: boolean;
  env?: Record<string, string>;
  timeout?: number;
  /**
   * Working directory for the command, and the `PROJECT_DIR` the child sees.
   *
   * Required — not optional — so every caller names the root it holds (a run's
   * session roots, a tool call's `roots.workspace`, the host's roots at
   * command entry) instead of the command reaching for an ambient one
   * (#12421). `undefined` is the honest answer only where the caller itself
   * has no folder, and it fails the run the same way the ambient miss did.
   */
  cwd: string | undefined;
  /**
   * The setting slots the command's git identity is read from: whether this
   * workspace marks agent commits, and the name and email it marks them with.
   *
   * Required — not optional — so every caller names the stores it holds (a
   * run's session roots, a tool call's `call.roots`, the host's roots at
   * command entry) instead of the command reaching for an ambient one.
   * `undefined` is the honest answer only where the caller itself has no
   * workspace, and it then carries no TeXRA git identity exactly as an
   * uninitialised ambient read did.
   */
  settings: SettingsStores | undefined;
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
  /**
   * A caller-owned cancellation channel, for the one case fiber interruption
   * cannot express: a command whose **result still has to be delivered** after
   * it is stopped (the background bash child run, whose strategy sets
   * `deliverAfterInterrupt`). Aborting it terminates the subprocess and any
   * shell children, and the call still resolves — with exit code 130 when the
   * child reports none.
   *
   * Every other caller stops the command by interrupting the fiber: teardown
   * is identical and the abandoned result is exactly what interruption means.
   */
  signal?: AbortSignal;
  /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
  quiet?: boolean;
  /**
   * Terminate the whole process tree on abort or timeout instead of only the
   * tracked process. Array form only: the shell form already signals its whole
   * group. Opt in for tools that hand the work to a delegate (ImageMagick and
   * GraphicsMagick rasterize PDF pages through Ghostscript) so the delegate is
   * signalled as part of the same teardown.
   *
   * Maps to execa's `killDescendants`: a new process group on POSIX,
   * `taskkill /T` on Windows. Termination is initiated, not joined: the call
   * still settles from the tracked process, and nothing waits for the
   * descendants to exit.
   */
  killProcessTree?: boolean;
}

/** Mutable per-invocation teardown state shared by the watchers below. */
interface CommandTeardown {
  shellTimedOut: boolean;
  shellAborted: boolean;
  interrupted: boolean;
  forceKillTimeoutId: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Execute external command with output handling and workspace path management.
 *
 * Never fails: every spawn error, non-zero exit, timeout and max-buffer trip is
 * reported in the {@link ExecResult} (`success`, `exitCode`, `timedOut`,
 * `outputLimitExceeded`), so callers need no error channel of their own.
 *
 * Interrupting the fiber tears the subprocess down — that is the cancellation
 * path for every caller but the background-bash one that needs a result back
 * (see {@link ExecuteCommandBaseOptions.signal}).
 *
 * The command form picks the teardown strategy:
 *
 * - the array form spawns one process and leaves abort/timeout signalling to
 *   execa's native `cancelSignal` / `forceKillAfterDelay`, plus a
 *   stream-destroy backstop. By default it has no process-group semantics: a
 *   descendant that inherited stdio is intentionally left alone.
 *   `killProcessTree` opts a call into whole-tree signalling (a process group
 *   on POSIX, `taskkill /T` on Windows); even then the await tracks only the
 *   spawned process, so the tree is signalled, not joined.
 * - the string form spawns a detached shell and signals SIGTERM/SIGKILL via
 *   `signalProcessGroup` on the negative PID so piped children and
 *   backgrounded jobs are torn down as a unit. Orphan risk on hard host kill,
 *   and a separate shell timeout, apply here.
 */
export function executeCommand(
  command: string | string[],
  options: ExecuteCommandBaseOptions,
): Effect.Effect<ExecResult> {
  return Effect.scoped(runCommand(command, options)).pipe(
    Effect.catch((error) =>
      Effect.succeed(logExecutionErrorAndBuildResult(error, options)),
    ),
  );
}

function runCommand(
  command: string | string[],
  options: ExecuteCommandBaseOptions,
): Effect.Effect<ExecResult, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    if (options.signal?.aborted) {
      return resultFromProcessOutput(null, 'Command aborted by user', 130);
    }

    const workspacePath = options.cwd;
    if (!workspacePath) {
      return yield* Effect.fail(new Error('No workspace path found'));
    }

    const encoding = normalizeEncoding(options.encoding);
    const log = createLog(options.channel ?? CHANNEL);
    const isArrayForm = Array.isArray(command);
    const teardown: CommandTeardown = {
      shellTimedOut: false,
      shellAborted: false,
      interrupted: false,
      forceKillTimeoutId: undefined,
    };

    const execaOptions: Options = {
      cwd: workspacePath,
      env: commandEnv(workspacePath, options.settings, options.env),
      encoding,
      timeout: options.timeout,
      reject: false,
      input: options.stdin,
      buffer: options.buffer,
      maxBuffer: options.maxBuffer,
      stdout: options.stdout,
      stderr: options.stderr,
    };

    const subprocess = yield* Effect.try({
      try: (): ResultPromise => {
        if (Array.isArray(command)) {
          const [cmd, ...args] = command;
          if (!options.quiet) {
            log.debug(`Running command: ${shellQuote(command)}`);
          }
          return execa(cmd, args, {
            ...execaOptions,
            cancelSignal: options.signal,
            forceKillAfterDelay: FORCE_KILL_DELAY_MS,
            // Passed through to execa: a process group on POSIX, `taskkill /T`
            // on Windows, so the signal reaches the Ghostscript delegate a
            // tracked-pid kill would leave behind.
            killDescendants: options.killProcessTree,
          });
        }
        if (!options.quiet) {
          log.debug(`Running command: ${command}`);
        }
        // Shell commands with pipes (e.g. "find / | head -2") create child
        // processes that inherit stdout.  execa's built-in timeout only kills
        // the shell process; the piped children keep stdout open which causes
        // the awaited subprocess to hang indefinitely.
        //
        // Fix: when a timeout is configured, spawn in a new process group
        // (detached) and kill the entire group (-pid) on timeout so all
        // children are terminated.  Without a timeout we use the normal
        // (non-detached) path to avoid orphan risk on parent crash.
        //
        // On Windows, negative-PID signaling is not supported so we fall back
        // to subprocess.kill() (kills the shell only) + stream destruction.
        //
        // Tradeoff: `detached` means the process group is NOT automatically
        // cleaned up if the extension host is hard-killed (SIGKILL / crash) --
        // long-running shell commands would be orphaned. This only affects
        // shell-form commands that opt into timeout/cancel handling, primarily
        // the bash tool. Acceptable because the alternative is an await that
        // hangs forever or approved children left running after a user stop.
        const { timeout, ...execaNoTimeout } = execaOptions;
        // Only use detached when we have a timeout/signal and need
        // process-group killing. On POSIX, detached creates a process group we
        // can kill as a unit. On Windows, detached opens a new console window
        // so we always skip it.
        const useDetached = (!!timeout || !!options.signal) && !IS_WINDOWS;
        return execa(command, {
          ...execaNoTimeout,
          shell: true,
          ...(useDetached ? { detached: true } : {}),
        });
      },
      catch: (error) => error,
    });

    // A command that ran to completion — including one its abort signal or
    // timeout tore down — must not leave a SIGKILL armed against a pid the OS
    // may recycle. An interrupted one is the opposite case: SIGTERM has just
    // been sent and the escalation behind it has to survive, which is why this
    // finalizer stands down once the interrupt handler below has fired.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (teardown.interrupted) return;
        if (teardown.forceKillTimeoutId !== undefined) {
          clearTimeout(teardown.forceKillTimeoutId);
          teardown.forceKillTimeoutId = undefined;
        }
      }),
    );

    const terminateGroup = (signal: NodeJS.Signals): void => {
      const pid = subprocess.pid;
      if (!pid) return;

      signalProcessGroup(pid, signal);

      // Force-kill after FORCE_KILL_DELAY_MS if SIGTERM didn't work, and
      // destroy the streams as a last resort so the await always unblocks.
      if (signal === 'SIGTERM' && teardown.forceKillTimeoutId === undefined) {
        teardown.forceKillTimeoutId = setTimeout(() => {
          signalProcessGroup(pid, 'SIGKILL');
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
        }, FORCE_KILL_DELAY_MS);
      }
    };

    // Array-form abort/force-kill is execa's (`cancelSignal` /
    // `forceKillAfterDelay` above), and execa signals only the tracked pid
    // unless `killProcessTree` asked for the whole tree: a descendant that
    // inherited stdio (e.g. `bash -c 'work & wait'`) can keep the pipes open
    // after the tracked process dies, hanging the await forever. Destroy the
    // streams once execa's force-kill delay has elapsed so the await always
    // unblocks. No signal is sent from here; the tree signal is execa's own
    // kill path.
    const armStreamDestroy = (): void => {
      if (teardown.forceKillTimeoutId !== undefined) return;
      teardown.forceKillTimeoutId = setTimeout(() => {
        subprocess.stdout?.destroy();
        subprocess.stderr?.destroy();
      }, FORCE_KILL_DELAY_MS);
    };

    const onAbort = isArrayForm
      ? armStreamDestroy
      : (): void => {
          teardown.shellAborted = true;
          terminateGroup('SIGTERM');
        };
    const onTimeout = isArrayForm
      ? armStreamDestroy
      : (): void => {
          teardown.shellTimedOut = true;
          terminateGroup('SIGTERM');
        };
    // Fiber interruption performs the same teardown the abort signal does; the
    // array form additionally needs the kill execa's `cancelSignal` would have
    // sent, since no signal is aborting here.
    const onInterrupt = isArrayForm
      ? (): void => {
          teardown.interrupted = true;
          // execa's `forceKillAfterDelay` and `killDescendants` apply to this
          // kill exactly as they do to the `cancelSignal` path.
          subprocess.kill('SIGTERM');
          armStreamDestroy();
        }
      : (): void => {
          teardown.interrupted = true;
          terminateGroup('SIGTERM');
        };

    if (options.signal) {
      yield* Effect.acquireRelease(
        Effect.sync(() => onAbortSignal(options.signal, onAbort)),
        (removeAbortListener) => Effect.sync(removeAbortListener),
      );
    }

    // The string form has no execa timeout (it was stripped above so the whole
    // process group is torn down rather than the shell alone); the array form
    // leaves the kill to execa and only arms the stream-destroy backstop.
    const timeoutMs = options.timeout;
    if (timeoutMs !== undefined && (isArrayForm || timeoutMs > 0)) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep(timeoutMs);
          onTimeout();
        }),
      );
    }

    yield* Effect.try({
      try: () => {
        if (subprocess.pid && options.onPid) options.onPid(subprocess.pid);
        // Subscribe to the output streams for live output if callbacks provided
        if (options.onStdout && subprocess.stdout) {
          subscribeDecodedOutput(subprocess.stdout, encoding, options.onStdout);
        }
        if (options.onStderr && subprocess.stderr) {
          subscribeDecodedOutput(subprocess.stderr, encoding, options.onStderr);
        }
      },
      catch: (error) => error,
    });

    const result = yield* Effect.tryPromise({
      try: () => subprocess,
      catch: (error) => error,
    }).pipe(Effect.onInterrupt(() => Effect.sync(onInterrupt)));

    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    // `shellAborted` covers the shell-form teardown path; `isCanceled` covers
    // the array-form path, aborted natively via execa's `cancelSignal`.
    const aborted = teardown.shellAborted || (result.isCanceled ?? false);
    const maxBufferExceeded = result.isMaxBuffer ?? false;
    const exitCode = maxBufferExceeded
      ? 2
      : (result.exitCode ?? (aborted ? 130 : 1));
    const timedOut = (result.timedOut ?? false) || teardown.shellTimedOut;
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
      logCommandStderr(log, normalizedStderr, options.truncate);
    }

    return resultFromProcessOutput(stdout, normalizedStderr, exitCode, {
      timedOut,
      outputLimitExceeded: maxBufferExceeded,
    });
  });
}

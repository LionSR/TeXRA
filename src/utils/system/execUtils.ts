import * as path from 'node:path';

import {
  Data,
  Duration,
  Effect,
  Fiber,
  Option,
  Result,
  type Scope,
  Stream,
} from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { quote as shellQuote } from 'shell-quote';

import { withLogChannel } from '@logger/effectLog';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { ApiKeyProviderId } from '@shared/constants/modelProviderPlugins';
import { API_KEY_ENV_NAMES, apiKeyEnvName } from '@shared/constants/providers';
import type { ExecResult } from '@shared/schemas';
import { onAbort } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { inheritedEnv } from '@utils/system/envFlags';
import { getGitAuthorEnv } from '@utils/system/gitAuthorEnv';
import {
  IS_WINDOWS,
  reportExtraDirWarnings,
  withExtendedPath,
} from '@utils/system/platformPaths';
import { toWindowsCommand } from '@utils/system/windowsCommandLine';
import type {
  ChildProcessHandle,
  ChildProcessSpawner,
} from 'effect/unstable/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';

const CHANNEL = 'execUtils';

/** SIGTERM to SIGKILL escalation for every teardown the scope runs. */
const FORCE_KILL_AFTER = Duration.seconds(5);
const DEFAULT_MAX_BUFFER = 100_000_000;
const MAX_LOGGED_STDERR = 150;

function normalizeOutput(text: string | null | undefined): string {
  return text?.trim() ?? '';
}

/**
 * The complete environment a command runs with: {@link inheritedEnv} on the
 * extended PATH, the git author identity, the caller's overrides, and the
 * project context an agent orients by.
 */
function commandEnv(
  workspacePath: string,
  authorEnv: Record<string, string | undefined> | undefined,
  envOverrides?: Record<string, string>,
): Record<string, string | undefined> {
  // withExtendedPath, not a bare `env.PATH =`: on Windows the copy of
  // `process.env` carries the variable as `Path`, so assigning `PATH` would
  // leave both spellings on the environment handed to the shell, and the one
  // the shell resolves against is then undefined.
  const env = withExtendedPath({
    ...inheritedEnv(),
    ...authorEnv,
    ...envOverrides,
  });
  env.PROJECT_DIR = workspacePath;
  env.PROJECT_NAME = path.basename(workspacePath);
  return env;
}

function resultFromProcessOutput(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  exitCode: number,
  flags: {
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
    noExitCode?: boolean;
  } = {},
): ExecResult {
  const timedOut = flags.timedOut ?? false;
  return {
    success: exitCode === 0 && !timedOut && !flags.outputLimitExceeded,
    stdout: normalizeOutput(stdout),
    stderr: normalizeOutput(stderr),
    timedOut,
    exitCode,
    ...(flags.outputLimitExceeded ? { outputLimitExceeded: true } : {}),
    ...(flags.noExitCode ? { noExitCode: true } : {}),
  };
}

/** The debug line that reports a command's stderr, or undefined when none. */
function commandStderrLogLine(
  stderr: string | null | undefined,
  truncate = false,
): string | undefined {
  const normalized = normalizeOutput(stderr);
  if (!normalized) return undefined;
  const logged =
    truncate && normalized.length > MAX_LOGGED_STDERR
      ? `...${normalized.slice(-MAX_LOGGED_STDERR)}`
      : normalized;
  return `Command stderr: ${logged}`;
}

export interface ExecuteCommandBaseOptions {
  readonly channel?: string;
  readonly truncate?: boolean;
  readonly env?: Record<string, string>;
  /** Milliseconds; undefined or `<= 0` sets no deadline. */
  readonly timeout?: number;
  /**
   * Working directory for the command, and the `PROJECT_DIR` the child sees.
   *
   * Required — not optional — so every caller names the root it holds (a run's
   * session roots, a tool call's `roots.workspace`, the host's roots at
   * command entry) instead of the command reaching for an ambient one
   * (#12421). `undefined` is the honest answer only where the caller itself
   * has no folder, and it fails the run the same way the ambient miss did.
   */
  readonly cwd: string | undefined;
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
  readonly settings: SettingsStores | undefined;
  /** Called with stdout chunks as they arrive, enabling live output streaming. */
  readonly onStdout?: (chunk: string) => void;
  /** Called with stderr chunks as they arrive, enabling live error streaming. */
  readonly onStderr?: (chunk: string) => void;
  /** Set to false to retain no output in memory (use with onStdout/onStderr). */
  readonly buffer?: boolean;
  /** Maximum decoded characters retained per output stream before the command is stopped. */
  readonly maxBuffer?: number;
  /**
   * A caller-owned cancellation channel, for the one case fiber interruption
   * cannot express: a command whose **result still has to be delivered** after
   * it is stopped (the background bash child run, whose strategy sets
   * `deliverAfterInterrupt`). Aborting it terminates the subprocess and any
   * shell children, and the call still resolves with exit code 130.
   *
   * Every other caller stops the command by interrupting the fiber: teardown
   * is identical and the abandoned result is exactly what interruption means.
   */
  readonly signal?: AbortSignal;
  /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
  readonly quiet?: boolean;
  /**
   * Terminate the whole process tree on abort or timeout instead of only the
   * tracked process. Array form only: the shell form already signals its whole
   * group. Opt in for tools that hand the work to a delegate (ImageMagick and
   * GraphicsMagick rasterize PDF pages through Ghostscript) so the delegate is
   * signalled as part of the same teardown: a new process group on POSIX; on
   * Windows the spawner's `taskkill /T` already reaches the tree.
   */
  readonly killProcessTree?: boolean;
}

/** One output stream passed `maxBuffer` decoded characters. */
class OutputLimitExceeded extends Data.TaggedError('OutputLimitExceeded')<{
  readonly stream: 'stdout' | 'stderr';
  readonly limit: number;
}> {}

/** How a spawned command ended, before it is read as an `ExecResult`. */
type Outcome =
  | { readonly _tag: 'Exited'; readonly code: number }
  // The exit-code read failed: the child died by a signal it was not sent.
  | { readonly _tag: 'Signalled'; readonly description: string }
  // A stdout or stderr read failed before the child ended.
  | { readonly _tag: 'ReadFailed'; readonly description: string }
  | { readonly _tag: 'TimedOut' }
  | { readonly _tag: 'Aborted' }
  | { readonly _tag: 'LimitExceeded'; readonly stream: 'stdout' | 'stderr' }
  | { readonly _tag: 'SpawnFailed'; readonly error: PlatformError };

/** Output kept so far; partial text survives a deadline or an abort. */
interface Captured {
  stdout: string;
  stderr: string;
}

function buildCommand(
  command: string | string[],
  options: ExecuteCommandBaseOptions,
  env: Record<string, string | undefined>,
): ChildProcess.StandardCommand {
  const common = {
    cwd: options.cwd,
    env,
    // `env` is already complete; extending would merge `process.env` back in,
    // restoring the withheld credential variables and the Windows
    // `Path`/`PATH` duplicate `commandEnv` removed.
    extendEnv: false,
    // Nothing writes to a command's stdin, so it gets EOF at once: a child
    // that reads stdin (a git hook, a lake build script) must not block on a
    // pipe no one will close.
    stdin: 'ignore' as const,
    forceKillAfter: FORCE_KILL_AFTER,
  };
  if (Array.isArray(command)) {
    const [argv0, ...args] = command;
    // A process group only when asked: without one, a descendant that
    // inherited stdio is left alone by an abort or timeout.
    const detached = options.killProcessTree === true && !IS_WINDOWS;
    return IS_WINDOWS
      ? toWindowsCommand(argv0, args, { ...common, detached })
      : ChildProcess.make(argv0, args, { ...common, detached });
  }
  // A shell that can be stopped runs as its own process group, so the stop
  // reaches piped children and backgrounded jobs. Without a deadline or a
  // signal it stays in ours, which avoids orphans on a hard host kill.
  const stoppable = (options.timeout ?? 0) > 0 || options.signal !== undefined;
  return ChildProcess.make(command, {
    ...common,
    shell: true,
    detached: stoppable && !IS_WINDOWS,
  });
}

/**
 * Decode `source` into `captured[name]`, stopping with `OutputLimitExceeded`
 * past `limit` characters. The decoder flushes a trailing partial character
 * once, at end of stream.
 */
function drain(
  source: Stream.Stream<Uint8Array, PlatformError>,
  name: 'stdout' | 'stderr',
  captured: Captured,
  options: ExecuteCommandBaseOptions,
): Effect.Effect<void, OutputLimitExceeded | PlatformError> {
  const onChunk = name === 'stdout' ? options.onStdout : options.onStderr;
  const limit = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const emit = (text: string): Effect.Effect<void, OutputLimitExceeded> => {
    if (text === '') return Effect.void;
    onChunk?.(text);
    if (options.buffer === false) return Effect.void;
    const room = limit - captured[name].length;
    captured[name] += text.slice(0, Math.max(room, 0));
    return text.length > room
      ? Effect.fail(new OutputLimitExceeded({ stream: name, limit }))
      : Effect.void;
  };
  return Effect.suspend(() => {
    const decoder = new TextDecoder();
    return source.pipe(
      Stream.runForEach((bytes) =>
        emit(decoder.decode(bytes, { stream: true })),
      ),
      Effect.andThen(Effect.suspend(() => emit(decoder.decode()))),
    );
  });
}

function describeFailure(error: PlatformError): string {
  return toErrorMessage(error.reason.cause ?? error.reason._tag);
}

function displayCommand(command: string | string[]): string {
  return Array.isArray(command) ? shellQuote(command) : command;
}

function resultFromOutcome(
  outcome: Outcome,
  { stdout, stderr }: Captured,
  command: string | string[],
  options: ExecuteCommandBaseOptions,
): ExecResult {
  switch (outcome._tag) {
    case 'Exited':
      return resultFromProcessOutput(stdout, stderr, outcome.code);
    case 'Signalled':
      return resultFromProcessOutput(
        stdout,
        stderr || `Command was killed: ${outcome.description}`,
        1,
        { noExitCode: true },
      );
    case 'ReadFailed':
      return resultFromProcessOutput(
        stdout,
        stderr || `Could not read the command's output: ${outcome.description}`,
        1,
        { noExitCode: true },
      );
    case 'TimedOut':
      return resultFromProcessOutput(
        stdout,
        stderr ||
          `Command timed out after ${options.timeout} milliseconds: ${displayCommand(command)}`,
        1,
        { timedOut: true },
      );
    case 'Aborted':
      return resultFromProcessOutput(
        stdout,
        stderr || 'Command aborted by user',
        130,
      );
    case 'LimitExceeded':
      return resultFromProcessOutput(
        stdout,
        stderr ||
          `Command's ${outcome.stream} was larger than ${options.maxBuffer ?? DEFAULT_MAX_BUFFER} characters (maxBuffer exceeded): ${displayCommand(command)}`,
        2,
        { outputLimitExceeded: true },
      );
    case 'SpawnFailed': {
      // Never `error.message`: it embeds the argv, which can carry a token.
      const { reason } = outcome.error;
      const detail = reason.description ? `: ${reason.description}` : '';
      return resultFromProcessOutput(
        '',
        `Command could not start: ${reason._tag}${detail}`,
        127,
        { noExitCode: true },
      );
    }
  }
}

/** Wait for the command to end, or its deadline, abort or output limit. */
const awaitOutcome = Effect.fnUntraced(function* (
  handle: ChildProcessHandle,
  captured: Captured,
  options: ExecuteCommandBaseOptions,
) {
  // Both streams are always drained, so a full pipe never blocks the child.
  const outFiber = yield* Effect.forkScoped(
    drain(handle.stdout, 'stdout', captured, options),
  );
  const errFiber = yield* Effect.forkScoped(
    drain(handle.stderr, 'stderr', captured, options),
  );
  const settled = Effect.all(
    [
      Fiber.join(outFiber),
      Fiber.join(errFiber),
      Effect.result(handle.exitCode),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    // The exit-code read fails only when the child died by a signal.
    Effect.map(([, , exit]): Outcome =>
      Result.isSuccess(exit)
        ? { _tag: 'Exited', code: exit.success }
        : { _tag: 'Signalled', description: describeFailure(exit.failure) },
    ),
    Effect.catchTag('OutputLimitExceeded', (error) =>
      Effect.succeed<Outcome>({ _tag: 'LimitExceeded', stream: error.stream }),
    ),
    // A stream read failed while the child may still run: the scope's
    // release, not an unref, ends it.
    Effect.catchTag('PlatformError', (error) =>
      Effect.succeed<Outcome>({
        _tag: 'ReadFailed',
        description: describeFailure(error),
      }),
    ),
  );
  const timeout = options.timeout ?? 0;
  const bounded =
    timeout > 0
      ? settled.pipe(
          Effect.timeoutOption(Duration.millis(timeout)),
          Effect.map(Option.getOrElse((): Outcome => ({ _tag: 'TimedOut' }))),
        )
      : settled;
  const { signal } = options;
  if (signal === undefined) return yield* bounded;
  const aborted = Effect.callback<Outcome>((resume) =>
    Effect.sync(
      onAbort(signal, () => resume(Effect.succeed({ _tag: 'Aborted' }))),
    ),
  );
  return yield* Effect.raceFirst(bounded, aborted);
});

/**
 * Spawn the command in the caller's scope and read how it ended. A command
 * that ends by itself is unreferenced first, so the scope's release skips the
 * clean-exit group terminate.
 */
const runSpawned = Effect.fnUntraced(function* (
  command: string | string[],
  options: ExecuteCommandBaseOptions,
  env: Record<string, string | undefined>,
  channel: string,
) {
  const captured: Captured = { stdout: '', stderr: '' };
  const spawned = yield* buildCommand(command, options, env).pipe(
    Effect.map((handle) => ({ _tag: 'Spawned', handle }) as const),
    Effect.catch((error: PlatformError) =>
      Effect.succeed({ _tag: 'SpawnFailed', error } as const),
    ),
  );
  const outcome: Outcome =
    spawned._tag === 'SpawnFailed'
      ? spawned
      : yield* awaitOutcome(spawned.handle, captured, options);
  if (
    spawned._tag === 'Spawned' &&
    (outcome._tag === 'Exited' || outcome._tag === 'Signalled')
  ) {
    yield* spawned.handle.unref.pipe(
      Effect.catch((error: PlatformError) =>
        Effect.logWarning(
          `Could not unreference an exited command: ${error.reason._tag}`,
        ).pipe(withLogChannel(channel)),
      ),
    );
  }
  return {
    outcome,
    result: resultFromOutcome(outcome, captured, command, options),
  };
});

/**
 * Execute an external command in `cwd` with the workspace env, over the
 * process's `ChildProcessSpawner`.
 *
 * Never fails: a spawn failure or missing cwd (127), a non-zero exit, a
 * timeout (`timedOut`), an abort (130) and a max-buffer trip (2,
 * `outputLimitExceeded`) are all reported in the {@link ExecResult}.
 *
 * The process lives exactly as long as this call's scope. A deadline, an
 * abort, an output-limit trip or an interrupted fiber closes that scope, and
 * that is the whole teardown: SIGTERM to the process (its group when it has
 * one), SIGKILL after five seconds, and a join on its exit. The array form
 * runs in our process group unless `killProcessTree` asks for its own; the
 * string form runs its shell in its own group whenever it can be stopped. A
 * command that ends by itself is unreferenced first, so a clean exit leaves
 * the jobs a detached shell backgrounded running, as a shell would.
 */
export const executeCommand = Effect.fn('executeCommand')(function* (
  command: string | string[],
  options: ExecuteCommandBaseOptions,
): Effect.fn.Return<ExecResult, never, ChildProcessSpawner> {
  if (options.signal?.aborted) {
    return resultFromProcessOutput('', 'Command aborted by user', 130);
  }
  const channel = options.channel ?? CHANNEL;
  const logError = (message: string) =>
    options.quiet
      ? Effect.void
      : Effect.logError(`Error executing command: ${message}`).pipe(
          withLogChannel(channel),
        );
  const { cwd } = options;
  if (!cwd) {
    yield* logError('No workspace path found');
    return resultFromProcessOutput('', 'No workspace path found', 127);
  }
  // The git identity is a setting read; a failed read fails this command,
  // reported like a spawn failure, rather than dropping the identity.
  const authorEnv = yield* Effect.result(getGitAuthorEnv(options.settings));
  if (authorEnv._tag === 'Failure') {
    const message = toErrorMessage(authorEnv.failure);
    yield* logError(message);
    return resultFromProcessOutput('', message, 127);
  }
  const env = commandEnv(cwd, authorEnv.success, options.env);
  yield* reportExtraDirWarnings;
  if (!options.quiet) {
    yield* Effect.logDebug(`Running command: ${displayCommand(command)}`).pipe(
      withLogChannel(channel),
    );
  }

  const { outcome, result } = yield* Effect.scoped(
    runSpawned(command, options, env, channel),
  );
  if (outcome._tag === 'SpawnFailed') {
    yield* logError(result.stderr);
  } else if (!options.quiet) {
    const stderrLine = commandStderrLogLine(result.stderr, options.truncate);
    if (stderrLine !== undefined) {
      yield* Effect.logDebug(stderrLine).pipe(withLogChannel(channel));
    }
  }
  return result;
});

import * as path from 'node:path';

import { Duration, Effect, Fiber, Result, Schema, Stream } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as CommandLine from 'effect/process/CommandLine';

import { withLogChannel } from '@logger/effectLog';
import type { ExecResult } from '@shared/schemas';
import { Settings, type SettingsStores } from '@shared/config/settings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { inheritedEnv } from '@utils/system/envFlags';
import { IS_WINDOWS, withCommandDirs } from '@utils/system/platformPaths';
import { toWindowsCommand } from '@utils/system/windowsCommandLine';
import type {
  ChildProcessHandle,
  ChildProcessSpawner,
} from 'effect/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';
import {
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_MARK_COMMITS_SETTING,
} from '@shared/state/stateSettings';

const CHANNEL = 'execUtils';

/** SIGTERM to SIGKILL escalation for every teardown the scope runs. */
const FORCE_KILL_AFTER = Duration.seconds(5);
const DEFAULT_MAX_BUFFER = 100_000_000;
/**
 * A POSIX shell's script around `command`: a sentinel reading the lifeline
 * on fd 3, then the command in a subshell, so a `wait` in it does not wait
 * on the sentinel. The sentinel kills the group when the lifeline ends
 * without a line (this process died) and exits quietly when it reads one
 * ({@link releaseLifeline}, sent once the command's stdout and stderr have
 * closed). Once the command's subshell returns the shell closes its own
 * copies of those streams, so they close when the last background job
 * holding them exits, and waits for the sentinel: a job backgrounded with
 * `&` stays covered for as long as this process waits on its output. The
 * shell reaps the sentinel itself: an orphaned one would stay in the
 * process group as a zombie until init reaps it, and the spawner's teardown
 * waits for the group to empty (seconds per command under a slow-reaping
 * init). The command starts on line 2, so the shell's error messages number
 * its lines as before.
 */
const withLifeline = (command: string): string =>
  '(read x <&3 || kill -s KILL 0) >/dev/null 2>&1 & texra_lifeline=$!; exec 3<&-; (\n' +
  `${command}\n)\n` +
  'texra_status=$?; exec >/dev/null 2>&1; wait $texra_lifeline; exit $texra_status\n';

/**
 * Sends {@link withLifeline}'s sentinel its line and ends the lifeline, so the
 * sentinel exits without killing the group and the shell can exit. A command
 * with no lifeline (the array form, Windows) has no fd 3, and the spawner
 * hands back a sink that discards the line. A failed write means the sentinel
 * is already gone; the exit code then says how the shell ended.
 */
const releaseLifeline = (handle: ChildProcessHandle): Effect.Effect<void> =>
  Stream.make(new TextEncoder().encode('\n')).pipe(
    Stream.run(handle.getInputFd(3)),
    Effect.ignore({
      log: 'Warn',
      message: "Could not release a shell command's lifeline",
    }),
    withLogChannel(CHANNEL),
  );

function normalizeOutput(text: string | null | undefined): string {
  return text?.trim() ?? '';
}

/**
 * Git author environment for a spawned process.
 *
 * When the calling session's workspace marks agent commits, these are merged
 * into the environment of every command {@link executeCommand} runs, so any
 * `git commit` carries the configured agent identity. Read at spawn time from
 * the setting slots the caller named on the command options, not from a value
 * applied once for the whole process: a process holding several projects
 * attributes each project's commits by that project's own setting. Empty when
 * the caller has no workspace, or when commit marking is off.
 */
const gitAuthorEnv = Effect.fn('gitAuthorEnv')(function* (
  settings: SettingsStores | undefined,
) {
  if (!settings) return {};
  if (!(yield* Settings.get(settings, GIT_MARK_COMMITS_SETTING))) {
    return {};
  }
  const name = yield* Settings.get(settings, GIT_AUTHOR_NAME_SETTING);
  const email = yield* Settings.get(settings, GIT_AUTHOR_EMAIL_SETTING);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
});

/**
 * The complete environment a command runs with: {@link inheritedEnv} on the
 * extended PATH, the git author identity, the caller's overrides, and the
 * project context an agent orients by.
 */
function commandEnv(
  inherited: Record<string, string>,
  workspacePath: string,
  authorEnv: Record<string, string | undefined> | undefined,
  envOverrides: Record<string, string> | undefined,
): Effect.Effect<Record<string, string | undefined>> {
  // withCommandDirs, not a bare `env.PATH =`: on Windows the copy of
  // `process.env` carries the variable as `Path`, so assigning `PATH` would
  // leave both spellings on the environment handed to the shell, and the one
  // the shell resolves against is then undefined.
  return withCommandDirs({
    ...inherited,
    ...authorEnv,
    ...envOverrides,
    PROJECT_DIR: workspacePath,
    PROJECT_NAME: path.basename(workspacePath),
  });
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

export interface ExecuteCommandBaseOptions {
  readonly env?: Record<string, string>;
  /** Milliseconds; undefined or `<= 0` sets no deadline. */
  readonly timeout?: number;
  /**
   * Working directory for the command, and the `PROJECT_DIR` the child sees.
   *
   * Required — not optional — so every caller names the root it holds (a run's
   * session roots, a tool call's `roots.workspace`, the host's roots at
   * command entry) instead of the command reaching for an ambient one.
   * `undefined` is the honest answer only where the caller itself
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
   * workspace, and it then carries no agent-commit identity, exactly as an
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
  /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
  readonly quiet?: boolean;
  /**
   * Terminate the whole process tree on interruption or timeout instead of only the
   * tracked process. Array form only: the shell form already signals its whole
   * group. Opt in for tools that hand the work to a delegate (ImageMagick and
   * GraphicsMagick rasterize PDF pages through Ghostscript) so the delegate is
   * signalled as part of the same teardown: a new process group on POSIX; on
   * Windows the spawner's `taskkill /T` already reaches the tree.
   */
  readonly killProcessTree?: boolean;
}

/** One output stream passed `maxBuffer` decoded characters. */
class OutputLimitExceeded extends Schema.TaggedError<OutputLimitExceeded>()(
  'OutputLimitExceeded',
  {
    stream: Schema.Literals(['stdout', 'stderr']),
    limit: Schema.Number,
  },
) {}

/** How a spawned command ended, before it is read as an `ExecResult`. */
type Outcome =
  | { readonly _tag: 'Exited'; readonly code: number }
  // The exit-code read failed: the child died by a signal it was not sent.
  | { readonly _tag: 'Signalled'; readonly description: string }
  // A stdout or stderr read failed before the child ended.
  | { readonly _tag: 'ReadFailed'; readonly description: string }
  | { readonly _tag: 'TimedOut' }
  | { readonly _tag: 'LimitExceeded'; readonly stream: 'stdout' | 'stderr' }
  | { readonly _tag: 'SpawnFailed'; readonly error: PlatformError };

/** Output kept so far; partial text survives a deadline. */
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
    // inherited stdio is left alone by an interruption or timeout.
    const detached = options.killProcessTree === true && !IS_WINDOWS;
    return IS_WINDOWS
      ? toWindowsCommand(argv0, args, { ...common, detached })
      : ChildProcess.make(argv0, args, { ...common, detached });
  }
  // cmd.exe has neither the sentinel's syntax nor POSIX process groups; the
  // spawner's `taskkill /T` reaches the tree on a stop.
  if (IS_WINDOWS) return ChildProcess.make(command, { ...common, shell: true });
  // A POSIX shell runs as its own process group, so a stop reaches piped
  // children and backgrounded jobs, and carries a lifeline: fd 3 is a pipe
  // only this process holds the write end of. The sentinel (`withLifeline`)
  // blocks reading it; when this process dies by any means, a SIGKILL or a
  // crash included, the kernel closes the write end and the sentinel kills
  // the whole group. The shell closes its own copy before the command runs,
  // so nothing the command starts inherits it. A stop is still the scope's
  // release (SIGTERM to the group, SIGKILL after five seconds), which ends
  // the sentinel with the rest of the group.
  return ChildProcess.make(withLifeline(command), {
    ...common,
    shell: true,
    detached: true,
    additionalFds: { fd3: { type: 'input' } },
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
  return toErrorMessage(error);
}

/** The command for a log or a message: argv quoted as this platform's
 *  programs split a command line, with control characters escaped. */
function displayCommand(command: string | string[]): string {
  return Array.isArray(command)
    ? CommandLine.display(command, { format: IS_WINDOWS ? 'windows' : 'posix' })
    : command;
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

/** Wait for the command to end, or its deadline or output limit. */
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
  // A shell exits only after its lifeline is released, and that waits for
  // both streams to close: until then a background job may still write.
  const settled = Effect.all([Fiber.join(outFiber), Fiber.join(errFiber)], {
    concurrency: 'unbounded',
  }).pipe(
    Effect.andThen(releaseLifeline(handle)),
    Effect.andThen(Effect.result(handle.exitCode)),
    // The exit-code read fails only when the child died by a signal.
    Effect.map((exit): Outcome =>
      Result.isSuccess(exit)
        ? { _tag: 'Exited', code: exit.success }
        : { _tag: 'Signalled', description: describeFailure(exit.failure) },
    ),
    Effect.catchTags({
      OutputLimitExceeded: (error) =>
        Effect.succeed<Outcome>({
          _tag: 'LimitExceeded',
          stream: error.stream,
        }),
      // A stream read failed while the child may still run: the scope's
      // release, not an unref, ends it.
      PlatformError: (error) =>
        Effect.succeed<Outcome>({
          _tag: 'ReadFailed',
          description: describeFailure(error),
        }),
    }),
  );
  const timeout = options.timeout ?? 0;
  return yield* timeout > 0
    ? settled.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeout),
          orElse: () => Effect.succeed<Outcome>({ _tag: 'TimedOut' }),
        }),
      )
    : settled;
});

/** Spawn the command in the caller's scope and read how it ended. */
const runSpawned = Effect.fnUntraced(function* (
  command: string | string[],
  options: ExecuteCommandBaseOptions,
  env: Record<string, string | undefined>,
) {
  const captured: Captured = { stdout: '', stderr: '' };
  const outcome: Outcome = yield* buildCommand(command, options, env).pipe(
    Effect.matchEffect({
      onFailure: (error: PlatformError) =>
        Effect.succeed<Outcome>({ _tag: 'SpawnFailed', error }),
      onSuccess: (handle) => awaitOutcome(handle, captured, options),
    }),
  );
  return {
    outcome,
    result: resultFromOutcome(outcome, captured, command, options),
  };
});

/**
 * Execute an external command in `cwd` with the workspace env, over the
 * process's `ChildProcessSpawner`. Its lines take the caller's log channel.
 *
 * Never fails: a spawn failure or missing cwd (127), a non-zero exit, a
 * timeout (`timedOut`) and a max-buffer trip (2,
 * `outputLimitExceeded`) are all reported in the {@link ExecResult}.
 *
 * The process lives exactly as long as this call's scope. A deadline, an
 * output-limit trip or an interrupted fiber closes that scope, and
 * that is the whole teardown: SIGTERM to the process (its group when it has
 * one), SIGKILL after five seconds, and a join on its exit. A command that
 * ends by itself gets the same release, so jobs its shell backgrounded end
 * with it. The array form runs in our process group unless
 * `killProcessTree` asks for its own; on POSIX the string form runs its shell
 * in its own group, on a lifeline that ends the group if this process dies
 * without running the release.
 */
export const executeCommand = Effect.fn('executeCommand')(function* (
  command: string | string[],
  options: ExecuteCommandBaseOptions,
): Effect.fn.Return<ExecResult, never, ChildProcessSpawner> {
  const logError = (message: string) =>
    options.quiet
      ? Effect.void
      : Effect.logError(`Error executing command: ${message}`);
  const { cwd } = options;
  if (!cwd) {
    yield* logError('No workspace path found');
    return resultFromProcessOutput('', 'No workspace path found', 127);
  }
  // The git identity is a setting read; a failed read fails this command,
  // reported like a spawn failure, rather than dropping the identity.
  const authorEnv = yield* Effect.result(gitAuthorEnv(options.settings));
  if (authorEnv._tag === 'Failure') {
    const message = toErrorMessage(authorEnv.failure);
    yield* logError(message);
    return resultFromProcessOutput('', message, 127);
  }
  const env = yield* commandEnv(
    yield* inheritedEnv(),
    cwd,
    authorEnv.success,
    options.env,
  );
  if (!options.quiet) {
    yield* Effect.logDebug(`Running command: ${displayCommand(command)}`);
  }

  const { outcome, result } = yield* Effect.scoped(
    runSpawned(command, options, env),
  );
  if (outcome._tag === 'SpawnFailed') {
    yield* logError(result.stderr);
  } else if (!options.quiet && result.stderr) {
    yield* Effect.logDebug(`Command stderr: ${result.stderr}`);
  }
  return result;
});

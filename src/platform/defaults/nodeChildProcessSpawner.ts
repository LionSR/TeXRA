/**
 * `ChildProcessSpawner` over `node:child_process` for the Node hosts.
 *
 * The first in-tree consumer of `effect/unstable/process`, kept to what its
 * one consumer (the direct Lean LSP lane) needs: a `StandardCommand` with
 * piped stdio becomes a scoped handle whose stdout and stderr are `Stream`s
 * over the Node readables, whose stdin is a `Sink` over the writable, and
 * whose `kill` and `exitCode` are effects. Closing the handle's scope sends
 * SIGTERM to a live child; a consumer that needs the wait-then-escalate
 * protocol runs it on `kill` and `exitCode` before its scope closes.
 *
 * Node reports a process it could not create (EMFILE, ENFILE, ENOENT) through
 * the child's `error` event on the next tick, not as a throw: `spawn` fails
 * with a `PlatformError` carrying that errno when the child has no stdio at
 * all (EMFILE/ENFILE), and otherwise returns the handle so `exitCode` fails
 * with the errno (ENOENT), letting the consumer race its handshake against
 * the exit. Piped commands, extra file descriptors, non-`pipe` stdio
 * configurations, and detached children are rejected loudly rather than
 * approximated: children run in the spawning process's group, which is what
 * the Lean lane's SIGTERM-then-SIGKILL shutdown assumes, so the contract's
 * `detached` default does not hold here and asking for it is an error.
 *
 * Provided locally by the Lean layer graph (`directLspAdapter.ts`), not by
 * the process runtime: a process-wide spawner is a later lane's call.
 */
import {
  spawn as nodeSpawn,
  type ChildProcess as NodeChildProcess,
} from 'node:child_process';

import {
  Cause,
  Deferred,
  Effect,
  Layer,
  PlatformError,
  Queue,
  Sink,
  Stream,
} from 'effect';
import {
  type ChildProcess,
  ChildProcessSpawner,
} from 'effect/unstable/process';
import type { Readable } from 'node:stream';

const MODULE = 'nodeChildProcessSpawner';

type ExitCode = ChildProcessSpawner.ExitCode;

const ERRNO_TAGS: Partial<Record<string, PlatformError.SystemErrorTag>> = {
  ENOENT: 'NotFound',
  EACCES: 'PermissionDenied',
  EPERM: 'PermissionDenied',
  EEXIST: 'AlreadyExists',
  EBUSY: 'Busy',
  EPIPE: 'BadResource',
};

function systemError(
  method: string,
  cause: unknown,
  description?: string,
): PlatformError.PlatformError {
  const errno = cause as Partial<NodeJS.ErrnoException> | null | undefined;
  return PlatformError.systemError({
    _tag: (errno?.code && ERRNO_TAGS[errno.code]) || 'Unknown',
    module: MODULE,
    method,
    description:
      description ?? (cause instanceof Error ? cause.message : String(cause)),
    syscall: errno?.syscall,
    cause,
  });
}

function isRunning(child: NodeChildProcess): boolean {
  return (
    child.pid !== undefined &&
    child.exitCode == null &&
    child.signalCode == null
  );
}

interface Spawned {
  readonly child: NodeChildProcess;
  /** Settles on `close` (stdio drained) with the code, or fails on `error`. */
  readonly exit: Deferred.Deferred<ExitCode, PlatformError.PlatformError>;
}

/**
 * Spawn and attach every listener in one synchronous block: the `error` that
 * reports a failed spawn arrives on the next tick, so the listener must exist
 * before the fiber can yield.
 */
function start(command: ChildProcess.StandardCommand): Spawned {
  const { options } = command;
  const child = nodeSpawn(command.command, command.args, {
    cwd: options.cwd,
    env: options.extendEnv ? { ...process.env, ...options.env } : options.env,
    shell: options.shell,
    windowsHide: options.windowsHide ?? true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = Deferred.makeUnsafe<ExitCode, PlatformError.PlatformError>();
  // `on`, not `once`: a later `error` (a failed `kill` on a child that never
  // spawned) must not become an unhandled emitter error; the first one wins
  // the exit.
  child.on('error', (error) => {
    Deferred.doneUnsafe(exit, Effect.fail(systemError('spawn', error)));
  });
  child.once('close', (code, signal) => {
    Deferred.doneUnsafe(
      exit,
      code == null
        ? Effect.fail(
            systemError(
              'exitCode',
              new Error(`Process terminated by signal ${signal}`),
            ),
          )
        : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    );
  });
  // A write that fails delivers its error to the write callback, which the
  // stdin sink surfaces, and a read failure reaches the stdout/stderr stream
  // while it is consumed; each pipe's own `error` event must still have a
  // listener for its whole life or Node throws it as an unhandled emitter
  // error once the consumer has detached.
  for (const pipe of [child.stdin, child.stdout, child.stderr]) {
    pipe?.on('error', () => undefined);
  }
  return { child, exit };
}

/**
 * A Node readable as a stream of its chunks. Event-driven rather than the
 * readable's async iterator: that iterator queues `return()` behind a
 * pending `next()`, so releasing it would wait for the pipe to close, which
 * only happens once the process is killed in a later finalizer. Detaching
 * the listeners is all the consumer owns; the pipe belongs to the process.
 */
const readable = (
  stream: Readable,
  fd: string,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  Stream.callback<Uint8Array, PlatformError.PlatformError>((queue) =>
    Effect.gen(function* () {
      const onData = (chunk: Uint8Array) => {
        Queue.offerUnsafe(queue, chunk);
      };
      const onEnd = () => {
        Queue.endUnsafe(queue);
      };
      const onError = (error: unknown) => {
        Queue.failCauseUnsafe(
          queue,
          Cause.fail(systemError(`read(${fd})`, error)),
        );
      };
      stream
        .on('data', onData)
        .once('end', onEnd)
        .once('close', onEnd)
        .once('error', onError);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stream
            .off('data', onData)
            .off('end', onEnd)
            .off('close', onEnd)
            .off('error', onError);
        }),
      );
    }),
  );

const spawn = Effect.fn('nodeChildProcessSpawner.spawn')(function* (
  command: ChildProcess.Command,
) {
  if (command._tag !== 'StandardCommand') {
    return yield* PlatformError.badArgument({
      module: MODULE,
      method: 'spawn',
      description: 'Piped commands are not supported',
    });
  }
  const { options } = command;
  if (options.detached === true) {
    return yield* PlatformError.badArgument({
      module: MODULE,
      method: 'spawn',
      description: 'Detached child processes are not supported',
    });
  }
  if (
    options.additionalFds !== undefined ||
    (options.stdin !== undefined && options.stdin !== 'pipe') ||
    (options.stdout !== undefined && options.stdout !== 'pipe') ||
    (options.stderr !== undefined && options.stderr !== 'pipe')
  ) {
    return yield* PlatformError.badArgument({
      module: MODULE,
      method: 'spawn',
      description: 'Only piped stdin, stdout, and stderr are supported',
    });
  }
  const { child, exit } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => start(command),
      catch: (error) => systemError('spawn', error),
    }),
    ({ child }) =>
      Effect.sync(() => {
        if (isRunning(child)) child.kill('SIGTERM');
      }),
  );
  const { stdin, stdout, stderr } = child;
  if (stdin == null || stdout == null || stderr == null) {
    // Node could not create the process (EMFILE/ENFILE): the child has no
    // stdio and reports the errno on `error`, which fails `exit`.
    yield* Deferred.await(exit);
    return yield* PlatformError.badArgument({
      module: MODULE,
      method: 'spawn',
      description: 'Child process has no stdio streams',
    });
  }

  const write = (chunk: Uint8Array) =>
    Effect.callback<void, PlatformError.PlatformError>((resume) => {
      if (stdin.destroyed || !stdin.writable) {
        resume(
          Effect.fail(
            systemError(
              'write(stdin)',
              new Error('stdin is closed'),
              'stdin is closed',
            ),
          ),
        );
        return;
      }
      stdin.write(chunk, (error) => {
        resume(
          error ? Effect.fail(systemError('write(stdin)', error)) : Effect.void,
        );
      });
    });
  const stdinSink = Sink.make<Uint8Array>()((input) =>
    Stream.runForEach(input, write).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!stdin.destroyed) stdin.end();
        }),
      ),
    ),
  );
  const stdoutStream = readable(stdout, 'stdout');
  const stderrStream = readable(stderr, 'stderr');
  const exitCode = Deferred.await(exit);

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(child.pid ?? -1),
    exitCode,
    isRunning: Effect.sync(() => isRunning(child)),
    kill: (killOptions) =>
      Effect.suspend(() => {
        if (!isRunning(child)) return Effect.void;
        const signal = killOptions?.killSignal ?? 'SIGTERM';
        if (!child.kill(signal)) {
          return Effect.fail(
            systemError('kill', new Error(`Failed to send ${signal}`)),
          );
        }
        if (killOptions?.forceKillAfter == null) return Effect.void;
        return Effect.ignore(exitCode).pipe(
          Effect.timeoutOrElse({
            duration: killOptions.forceKillAfter,
            orElse: () =>
              Effect.sync(() => {
                if (isRunning(child)) child.kill('SIGKILL');
              }),
          }),
        );
      }),
    stdin: stdinSink,
    stdout: stdoutStream,
    stderr: stderrStream,
    all: Stream.merge(stdoutStream, stderrStream),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.sync(() => {
      child.unref();
      return Effect.sync(() => child.ref());
    }),
  });
});

/** The Node-backed `ChildProcessSpawner`, for the Lean layer graph. */
export const nodeChildProcessSpawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make(spawn),
  );

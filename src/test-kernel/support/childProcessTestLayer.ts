/**
 * `ChildProcessSpawner` doubles for the process edge: the real Node spawner,
 * loaded lazily, for suites that run real processes on the harness runtime,
 * and a scripted spawner for suites that assert what would have been spawned.
 */
import { Effect, Layer, Sink, Stream } from 'effect';
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from 'effect/unstable/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';
import type * as ChildProcess from 'effect/unstable/process/ChildProcess';

/**
 * The real Node spawner, built synchronously and loading
 * `node:child_process` only on the first spawn: a setup file loads before a
 * suite's `vi.mock` registrations, so an eager import would cache the real
 * module ahead of a suite that mocks it, and the harness runtime is built by
 * `runSync` callers, so the layer itself cannot be asynchronous.
 */
export const nodeSpawnerLayer: Layer.Layer<ChildProcessSpawner> = Layer.succeed(
  ChildProcessSpawner,
)(
  makeSpawner((command) =>
    Effect.promise(async () => {
      const [spawner, fs, path] = await Promise.all([
        import('@effect/platform-node/NodeChildProcessSpawner'),
        import('@effect/platform-node/NodeFileSystem'),
        import('@effect/platform-node/NodePath'),
      ]);
      return spawner.layer.pipe(
        Layer.provide(Layer.mergeAll(fs.layer, path.layer)),
      );
    }).pipe(
      Effect.flatMap((layer) =>
        ChildProcessSpawner.use((real) => real.spawn(command)).pipe(
          Effect.provide(layer),
        ),
      ),
    ),
  ),
);

/** What a scripted command does: its output and exit code (a
 *  `PlatformError` there is a death by signal), a spawn failure, or never
 *  ending. */
type ScriptedAnswer =
  | {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number | PlatformError;
    }
  | PlatformError
  | 'hang';

const bytes = (text: string | undefined): Stream.Stream<Uint8Array> =>
  text ? Stream.make(new TextEncoder().encode(text)) : Stream.empty;

/**
 * A spawner that answers each command from `script` and spawns nothing.
 * `calls` records every command asked for; `killed` records each hanging
 * command whose scope closed, which is how a stopped process is observed.
 * Provide `layer` innermost so it shadows the harness spawner.
 */
export function scriptedSpawnerLayer(
  script: (command: ChildProcess.StandardCommand) => ScriptedAnswer,
): {
  readonly layer: Layer.Layer<ChildProcessSpawner>;
  readonly calls: ChildProcess.StandardCommand[];
  readonly killed: ChildProcess.StandardCommand[];
} {
  const calls: ChildProcess.StandardCommand[] = [];
  const killed: ChildProcess.StandardCommand[] = [];
  const spawner = makeSpawner((command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') {
        return yield* Effect.die(new Error('Piped commands are not scripted.'));
      }
      calls.push(command);
      const answer = script(command);
      if (answer !== 'hang' && '_tag' in answer) return yield* answer;
      const hang = answer === 'hang';
      if (hang) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => void killed.push(command)),
        );
      }
      const stdout = hang ? Stream.never : bytes(answer.stdout);
      const stderr = hang ? Stream.never : bytes(answer.stderr);
      const code = hang ? undefined : answer.exitCode;
      const exited =
        typeof code === 'object'
          ? Effect.fail(code)
          : Effect.succeed(ExitCode(code ?? 0));
      return makeHandle({
        pid: ProcessId(calls.length),
        exitCode: hang ? Effect.never : exited,
        isRunning: Effect.succeed(hang),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return {
    layer: Layer.succeed(ChildProcessSpawner)(spawner),
    calls,
    killed,
  };
}

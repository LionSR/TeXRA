import { Effect, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import type { PlatformError } from 'effect/PlatformError';

/**
 * Run an interactive command on the terminal and answer its exit code: stdout
 * and stderr are the terminal's, and stdin is too unless `input` is given, in
 * which case the child reads that text and then end of file.
 *
 * The child stays in our process group (`detached: false`). A child in a
 * background group that reads or writes the TTY is stopped by SIGTTIN or
 * SIGTTOU, which would freeze a pager or an installer prompt. The string form
 * runs through the shell, for `$PAGER` flags and `&&` chains. A child that
 * dies by a signal (Ctrl-C) fails with the `PlatformError`; callers map it.
 */
export const runForegroundCommand = Effect.fn('runForegroundCommand')(
  function* (
    command: string | readonly [string, ...string[]],
    options: {
      readonly input?: string;
      readonly env?: Record<string, string | undefined>;
    } = {},
  ): Effect.fn.Return<number, PlatformError, ChildProcessSpawner> {
    const spawner = yield* ChildProcessSpawner;
    const common: ChildProcess.CommandOptions = {
      stdin:
        options.input === undefined
          ? 'inherit'
          : Stream.make(new TextEncoder().encode(options.input)),
      stdout: 'inherit',
      stderr: 'inherit',
      env: options.env,
      extendEnv: true,
      detached: false,
      forceKillAfter: '5 seconds',
    };
    const built =
      typeof command === 'string'
        ? ChildProcess.make(command, { ...common, shell: true })
        : ChildProcess.make(command[0], command.slice(1), common);
    return yield* spawner.exitCode(built);
  },
);

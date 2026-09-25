import { Effect, Exit, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { CliExitCode } from './exitCodes';
import type { PlatformError } from 'effect/PlatformError';

/**
 * While a foreground child owns the terminal, Ctrl-C belongs to it: the
 * terminal sends SIGINT to the whole process group, and a pager such as
 * `less` uses it to cancel a search, not to end the listing. So the platform's
 * SIGINT handler defers while any foreground command runs, as a shell or C's
 * `system()` does, and the interrupt is acted on only if the child itself
 * died by a signal: then it is re-raised once the terminal is ours again.
 */
let foregroundHolders = 0;
let interruptedWhileHeld = false;

/** Whether a foreground command owns the terminal now; the platform's SIGINT
 *  handler records the interrupt with {@link deferInterrupt} instead of
 *  shutting down. */
export function terminalForegroundHeld(): boolean {
  return foregroundHolders > 0;
}

/** Record a SIGINT that arrived while a foreground command owned the terminal. */
export function deferInterrupt(): void {
  interruptedWhileHeld = true;
}

// Present while the terminal is held, so a SIGINT never takes Node's default
// exit even when no platform handler is installed.
const holdInterrupt = (): void => {
  interruptedWhileHeld = true;
};

const holdTerminal = Effect.sync(() => {
  if (foregroundHolders++ === 0) {
    interruptedWhileHeld = false;
    process.on('SIGINT', holdInterrupt);
  }
});

/** The child stopped because of the interrupt: killed by a signal (the
 *  spawner fails the exit-code read), or exited 130, the shell's code for a
 *  process that handled SIGINT by quitting. */
const endedByInterrupt = (exit: Exit.Exit<number, PlatformError>): boolean => {
  if (Exit.isSuccess(exit)) return exit.value === CliExitCode.Interrupted;
  const error = Exit.findErrorOption(exit);
  return error._tag === 'Some' && error.value.reason.method === 'exitCode';
};

const releaseTerminal = (exit: Exit.Exit<number, PlatformError>) =>
  Effect.sync(() => {
    if (--foregroundHolders > 0) return;
    process.removeListener('SIGINT', holdInterrupt);
    // The child died by a signal after a Ctrl-C: the user meant to stop, so
    // the parent takes the interrupt it deferred. A child that handled the
    // Ctrl-C itself and exited on its own (a pager) keeps us running.
    if (interruptedWhileHeld && endedByInterrupt(exit)) {
      interruptedWhileHeld = false;
      process.kill(process.pid, 'SIGINT');
    }
  });

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
    return yield* Effect.acquireUseRelease(
      holdTerminal,
      () => spawner.exitCode(built),
      (_, exit) => releaseTerminal(exit),
    );
  },
);

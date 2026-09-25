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
 * `system()` does. When the child ends, the command interrupts its own fiber
 * if the child ended because of that Ctrl-C; the CLI's command boundary maps
 * an interruption to exit 130, so the outcome does not race process exit.
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

/** The child stopped after the Ctrl-C: killed by a signal, or exited 130, the
 *  shell's code for a process that handled SIGINT by quitting. The spawner
 *  keeps only a message naming the signal, so any signal death after a
 *  Ctrl-C counts: a pager that survived the Ctrl-C and later died of SIGHUP
 *  would read as interrupted too. */
const endedByInterrupt = (exit: Exit.Exit<number, PlatformError>): boolean => {
  if (Exit.isSuccess(exit)) return exit.value === CliExitCode.Interrupted;
  const error = Exit.findErrorOption(exit);
  return error._tag === 'Some' && error.value.reason.method === 'exitCode';
};

const releaseTerminal = Effect.sync(() => {
  if (--foregroundHolders > 0) return;
  process.removeListener('SIGINT', holdInterrupt);
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
 * dies by a signal fails with the `PlatformError`; callers map it. After a
 * Ctrl-C the command is interrupted instead (see above).
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
    const { exit, interrupted } = yield* Effect.acquireUseRelease(
      holdTerminal,
      () =>
        Effect.exit(spawner.exitCode(built)).pipe(
          Effect.map((exit) => ({ exit, interrupted: interruptedWhileHeld })),
        ),
      () => releaseTerminal,
    );
    // The user meant to stop: the child died of the Ctrl-C. A child that
    // handled it and exited on its own (a pager) keeps the command running.
    if (interrupted && endedByInterrupt(exit)) return yield* Effect.interrupt;
    return yield* exit;
  },
);

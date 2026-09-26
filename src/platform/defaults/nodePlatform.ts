/**
 * The Node standard-library services every process serves once: the
 * filesystem, path, and child-process spawner. `installProcessRuntime` merges
 * this layer into every root's runtime, so a program that reads a file or
 * starts a child process takes the service from context instead of building a
 * Node layer of its own. Module paths, never the `@effect/platform-node`
 * barrel, so loading this pulls in only these three services.
 *
 * The spawner is the pinned `@effect/platform-node` one under a supervisor
 * that adds two things it lacks (#13182):
 *
 * - A bounded teardown. The upstream release signals the child, waits its
 *   grace (or `forceKillAfter` plus a SIGKILL grace), then awaits the exit
 *   event with no limit, so a child that ignores SIGTERM without a
 *   `forceKillAfter`, or sleeps uninterruptibly, would hold Stop, a shutdown
 *   phase and runtime disposal forever. Each spawn runs in a child scope the
 *   supervisor closes on a detached fiber and awaits under a budget. Only
 *   the wait is bounded, never the close: a timeout straight on the close
 *   would interrupt the upstream finalizer mid-teardown (its wait for the
 *   exit event), abandoning the child instead of reaping it.
 *   Past the budget a still-running child gets one SIGKILL and a warning
 *   naming its pid; the detached close keeps running and reaps a late exit.
 *   `handle.kill` gets the same budget, so a kill with no `forceKillAfter`
 *   escalates to SIGKILL after about 2 s where upstream waited forever. The
 *   close runs on a detached fiber: a failure inside the budget is re-raised
 *   to the caller's scope, and one that lands later is logged at warn. The
 *   budget is upstream's own bounded
 *   tail (`forceKillAfter` plus its grace) plus slack, so a shutdown phase
 *   now waits at most one bounded close per child. For a command with the
 *   5 s `forceKillAfter` most callers pass that is 7 s on POSIX and 9 s on
 *   Windows (wider slack), finite but past the 5 s lifecycle phase deadline.
 * - Parent-exit cleanup. Every child still registered when the process emits
 *   `exit` gets SIGTERM from a synchronous listener, its process group when it
 *   leads one. Every child, detached or not: the POSIX default is detached,
 *   and nothing TeXRA starts through this spawner is meant to outlive it
 *   (background runs are drained). A child leaves the set when it exits or
 *   its scope closes. On Windows this is TerminateProcess on the child alone
 *   (taskkill is asynchronous and cannot run in `exit`).
 *
 *   Node emits `exit` only for a normal exit (`process.exit`, an empty event
 *   loop, an uncaught error), not for a death by a signal no one handles. So
 *   this is narrower than execa's `cleanup: true`, whose `signal-exit` also
 *   hooked SIGHUP, SIGINT and SIGTERM: a host that dies from an unhandled
 *   signal (the CLI on SIGHUP when its terminal closes, the extension host or
 *   Electron main on a bare SIGTERM) or from SIGKILL still leaves its
 *   group-leading children running. Handling those signals belongs to each
 *   host's signal owner (the CLI's in `initPlatform.ts`), which ends in a
 *   normal exit and so reaches this listener.
 *
 * The layer's release only removes the `exit` listener and never kills a
 * live child: `nodePlatformServices` is also provided per call (the CLI
 * external opener, the degraded doctor report) and per test runtime in the
 * test kernel, so a release-time kill would end a child as its spawn
 * returned. Runtime disposal already closes the scopes that own the children.
 *
 * A piped command's handle carries only its last stage's pid, so only that
 * stage is registered for the `exit` listener and signalled past the budget;
 * earlier stages keep upstream's own release under the same bounded wait.
 * Nothing in production pipes commands today.
 *
 * The double taskkill after a non-zero Windows exit lives inside the upstream
 * spawner, on a `ChildProcess` the handle never exposes, so no wrapper here
 * can remove it; that fix belongs to the upstream module.
 */
import { writeSync } from 'node:fs';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Layer,
  Option,
  type Path,
  Scope,
} from 'effect';
import {
  type ChildProcessHandle,
  ChildProcessSpawner,
  make as makeSpawner,
  makeHandle,
} from 'effect/unstable/process/ChildProcessSpawner';
import { withLogChannel } from '@logger/effectLog';
import { ensureError } from '@utils/errors/errorMessage';
import type * as ChildProcess from 'effect/unstable/process/ChildProcess';
import type { PlatformError } from 'effect/PlatformError';

const CHANNEL = 'ChildProcesses';

/** Upstream's wait after each signal (`processGroupGraceMillis` in the
 *  rc.117 `NodeChildProcessSpawner`); recheck it on an Effect bump. */
const UPSTREAM_GRACE_MILLIS = 1_000;
/** Slack over upstream's bounded tail before a teardown counts as stuck.
 *  Wider on Windows, where upstream's teardown awaits a `taskkill` spawn
 *  that can take seconds on a loaded machine. */
const TEARDOWN_SLACK_MILLIS = process.platform === 'win32' ? 3_000 : 1_000;

const stages = (
  command: ChildProcess.Command,
): ReadonlyArray<ChildProcess.StandardCommand> =>
  command._tag === 'StandardCommand'
    ? [command]
    : [...stages(command.left), ...stages(command.right)];

/** The stage whose pid a piped handle carries. */
const lastStage = (
  command: ChildProcess.Command,
): ChildProcess.StandardCommand =>
  command._tag === 'StandardCommand' ? command : lastStage(command.right);

/** Upstream's legitimate teardown, summed over stages: the signal, then
 *  `forceKillAfter` and a SIGKILL grace, or the grace alone, plus slack. */
const teardownBudgetMillis = (
  command: ChildProcess.Command,
  killOptions: (
    stage: ChildProcess.StandardCommand,
  ) => ChildProcess.KillOptions | undefined,
): number =>
  stages(command).reduce(
    (total, stage) =>
      total +
      Duration.toMillis(killOptions(stage)?.forceKillAfter ?? Duration.zero) +
      UPSTREAM_GRACE_MILLIS +
      TEARDOWN_SLACK_MILLIS,
    0,
  );

/** Whether signals reach the child's process group: upstream spawns POSIX
 *  children detached (their own group leader) unless told otherwise. */
const leadsGroup = (command: ChildProcess.StandardCommand): boolean =>
  process.platform !== 'win32' && command.options.detached !== false;

/** Past its budget: one SIGKILL to a child still running, then a warning
 *  naming the pid. The pid is signalled only while Node has not seen its
 *  exit, so a reused pid is not hit here; the exit listener's sweep can race
 *  a reap by milliseconds (see `killLive`). Without a handle (a spawn that failed
 *  or was interrupted after upstream acquired a stage) there is no pid to
 *  signal, only the warning. */
const stopWaiting = (
  handle: ChildProcessHandle | undefined,
  command: ChildProcess.Command,
  budgetMs: number,
  via: 'scope close' | 'kill',
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const stage = lastStage(command);
    if (handle === undefined) {
      return yield* Effect.logWarning(
        'Teardown of a failed child process spawn outlived its budget; stopped waiting',
      ).pipe(Effect.annotateLogs({ command: stage.command, budgetMs, via }));
    }
    const running = yield* handle.isRunning.pipe(
      Effect.catch((error: PlatformError) =>
        Effect.logWarning(
          `Could not tell whether child process ${handle.pid} is running: ${error.message}`,
        ).pipe(Effect.as(false)),
      ),
    );
    if (running) {
      yield* Effect.try({
        try: () =>
          process.kill(leadsGroup(stage) ? -handle.pid : handle.pid, 'SIGKILL'),
        catch: ensureError,
      }).pipe(
        Effect.catch((error: Error) =>
          Effect.logWarning(
            `Could not SIGKILL child process ${handle.pid}: ${error.message}`,
          ),
        ),
      );
    }
    yield* Effect.logWarning(
      running
        ? 'Child process outlived its teardown budget; sent SIGKILL and stopped waiting'
        : 'Child process teardown outlived its budget; stopped waiting',
    ).pipe(
      Effect.annotateLogs({
        pid: handle.pid,
        command: stage.command,
        budgetMs,
        via,
      }),
    );
  }).pipe(withLogChannel(CHANNEL));

/** The supervisor over the upstream spawner, built once per layer build. */
const supervisedSpawner = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner;
    // Live children and whether each leads its process group; plain state so
    // the synchronous `exit` listener can read it. Unlike stopWaiting, the
    // sweep cannot ask the handle whether Node already reaped a child (that
    // answer is an Effect), so a pid whose exit watcher has not yet run
    // `forget` is signalled even if the OS reused it in that window.
    const live = new Map<number, { readonly group: boolean }>();
    const killLive = () => {
      for (const [pid, { group }] of live) {
        try {
          process.kill(group ? -pid : pid, 'SIGTERM');
        } catch (error) {
          // ESRCH: already gone. Anything else means this child survives the
          // parent, and an exit listener can only write synchronously.
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            writeSync(
              2,
              `TeXRA: could not stop child process ${pid} at exit: ${code ?? ensureError(error).message}\n`,
            );
          }
        }
      }
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on('exit', killLive)),
      () => Effect.sync(() => process.off('exit', killLive)),
    );

    const spawn = (command: ChildProcess.Command) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const child = yield* Scope.make();
          const entry = { group: leadsGroup(lastStage(command)) };
          const forget = (pid: number) => {
            if (live.get(pid) === entry) live.delete(pid);
          };
          // Close the child scope under the budget, on a detached fiber: a
          // close failure inside the budget is the caller's, a late one is
          // logged, and past the budget a running child is SIGKILLed.
          const closeChild = (
            handle: ChildProcessHandle | undefined,
            exit: Exit.Exit<unknown, unknown>,
          ) =>
            Effect.gen(function* () {
              const budgetMs = teardownBudgetMillis(
                command,
                (stage) => stage.options,
              );
              const closing = yield* Scope.close(child, exit).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (handle !== undefined) forget(handle.pid);
                  }),
                ),
                Effect.forkDetach,
              );
              const closed = yield* Fiber.await(closing).pipe(
                Effect.timeoutOption(budgetMs),
              );
              if (Option.isSome(closed)) {
                if (Exit.isFailure(closed.value)) {
                  return yield* Effect.failCause(closed.value.cause);
                }
                return;
              }
              yield* stopWaiting(handle, command, budgetMs, 'scope close');
              yield* Fiber.await(closing).pipe(
                Effect.flatMap((late) =>
                  Exit.isFailure(late) && !Cause.hasInterruptsOnly(late.cause)
                    ? Effect.logWarning(
                        `Late teardown of child process ${handle?.pid ?? lastStage(command).command} failed: ${Cause.pretty(late.cause)}`,
                      )
                    : Effect.void,
                ),
                withLogChannel(CHANNEL),
                Effect.forkDetach,
              );
            });
          // A failed or interrupted spawn closes its child scope at once, so
          // nothing is left on the caller's scope; a live child's close is
          // registered only once it exists.
          const handle = yield* restore(
            inner.spawn(command).pipe(Scope.provide(child)),
          ).pipe(
            Effect.onError((cause) =>
              closeChild(undefined, Exit.failCause(cause)),
            ),
          );
          yield* Effect.addFinalizer((exit) => closeChild(handle, exit));
          live.set(handle.pid, entry);
          // Leaves the set on exit; a close that interrupts this watcher
          // leaves the entry to the close, so a stuck child stays killable.
          yield* handle.exitCode.pipe(
            Effect.exit,
            Effect.andThen(Effect.sync(() => forget(handle.pid))),
            Effect.forkIn(child),
          );
          return makeHandle({
            ...handle,
            kill: (options?: ChildProcess.KillOptions) => {
              const budgetMs = teardownBudgetMillis(command, () => options);
              return handle.kill(options).pipe(
                Effect.timeoutOption(budgetMs),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      stopWaiting(handle, command, budgetMs, 'kill'),
                    onSome: () => Effect.void,
                  }),
                ),
              );
            },
          });
        }),
      );

    return makeSpawner(spawn);
  }),
);

export const nodePlatformServices: Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> = supervisedSpawner.pipe(
  Layer.provide(NodeChildProcessSpawner.layer),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

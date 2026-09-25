import { Cause, Clock, Deferred, Effect, Option } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownHandler,
  type ShutdownPhase,
} from '../interfaces';

const CHANNEL = 'LifecycleHost';

/** One `onShutdown` call. Registrations are compared by entry identity, not by
 *  handler identity, so registering the same program twice yields two
 *  independent entries and a Disposable can only remove its own. */
interface Registration {
  readonly handler: ShutdownHandler;
}

/**
 * Join-with-deadline bound for one shutdown phase. A hung handler must not
 * wedge desktop quit, eat the extension's ~5s deactivate budget, or stall a
 * CLI SIGTERM indefinitely: the phase's remaining budget bounds each handler,
 * and a handler still running when it runs out is interrupted before the
 * drain advances past it, so a late BEFORE handler cannot race the ON phase's
 * disposals without having been told to stop first. A handler whose work must
 * outlast the budget says so with `Effect.uninterruptible`: the interrupt
 * waits on it, so the drain advances only once it settles. The same deadline
 * bounds a session close (`Sessions.close`), counted from the close's start,
 * and the process release closes every session it still holds at once, so
 * they settle under one deadline for the process, not one each.
 */
export const SHUTDOWN_PHASE_DEADLINE_MS = 5_000;

interface CreateLifecycleHostOptions {
  onError?: (phase: ShutdownPhase, error: unknown) => void;
}

export function createLifecycleHost(
  options: CreateLifecycleHostOptions = {},
): LifecycleHost {
  const handlers: Record<ShutdownPhase, Registration[]> = {
    [SHUTDOWN_PHASE.BEFORE]: [],
    [SHUTDOWN_PHASE.ON]: [],
  };
  let drain: Effect.Effect<void> | undefined;

  const { onError } = options;
  const reportFailure = (
    phase: ShutdownPhase,
    error: unknown,
  ): Effect.Effect<void> =>
    onError
      ? Effect.sync(() => onError(phase, error))
      : Effect.logError(`[lifecycle] ${phase} handler failed`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
        );

  // Sequential — handlers within a phase run in registration order. Parallel
  // disposal can race (e.g. flushState writing to UsageLogService while it is
  // disposing); the old hand-rolled deactivate() relied on this ordering.
  // One budget for the whole phase, spent down handler by handler: the
  // timeout interrupts the handler in flight and reports it as a laggard,
  // then the drain advances. A handler that starts with the budget already
  // gone still gets the scheduler tick `Effect.sleep(0)` yields, which is
  // what lets a synchronous disposal run on the way out.
  const runPhase = (phase: ShutdownPhase): Effect.Effect<void> =>
    Effect.gen(function* () {
      const registrations = handlers[phase].splice(0);
      if (registrations.length === 0) return;
      const started = yield* Clock.currentTimeMillis;
      for (const registration of registrations) {
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        const settled = yield* Effect.timeoutOption(
          registration.handler,
          Math.max(SHUTDOWN_PHASE_DEADLINE_MS - elapsed, 0),
        ).pipe(
          // Outside the timeout: what reaches here is the handler's own
          // failure or defect, never the interruption the timeout raises to
          // cut it short.
          Effect.catchCause((cause) =>
            reportFailure(phase, Cause.squash(cause)).pipe(
              Effect.as(Option.some<void>(undefined)),
            ),
          ),
        );
        if (Option.isNone(settled)) {
          yield* reportFailure(
            phase,
            new Error(
              `Shutdown handler did not settle within ${SHUTDOWN_PHASE_DEADLINE_MS}ms; advancing without it`,
            ),
          );
        }
      }
    });

  return {
    onShutdown(phase, handler) {
      const registration: Registration = { handler };
      handlers[phase].push(registration);
      return {
        // Idempotent: once this entry is gone (disposed already, or drained by
        // runShutdown) a repeat dispose finds nothing and removes nothing.
        dispose: () => {
          const index = handlers[phase].indexOf(registration);
          if (index !== -1) handlers[phase].splice(index, 1);
        },
      };
    },
    // Cache the drain in flight so concurrent callers (e.g. a second
    // before-quit firing during the first shutdown) join the same drain
    // instead of getting an immediately-succeeding noop.
    runShutdown: Effect.suspend(() => {
      if (drain) return drain;
      const joined = Deferred.makeUnsafe<void>();
      drain = Deferred.await(joined);
      return runPhase(SHUTDOWN_PHASE.BEFORE).pipe(
        Effect.andThen(runPhase(SHUTDOWN_PHASE.ON)),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(joined, exit);
          }),
        ),
      );
    }),
    // The cache above is also the answer: once a drain exists, the phases
    // have been spliced and a later registration has no drain of its own.
    get shutdownRan() {
      return drain !== undefined;
    },
  };
}

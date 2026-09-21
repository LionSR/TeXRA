/**
 * One turn of a child run, against the child's stop.
 *
 * The child-run loop (`childRunLoop.ts`) owns the run and the one controller
 * every turn of it is driven under; this module owns what is built on that
 * controller's signal: the two Effect races and the turn classification, so
 * the loop's body reads as turns and deliveries rather than as signal
 * bookkeeping. Everything here takes the signal itself, so the loop's
 * cancellation owner stays one object in one file.
 *
 * Host-agnostic, VS Code-free.
 */

import { Cause, Effect, Exit } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { onAbort } from '@utils/core';
import { formatDuration } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Minimal token usage shape consumed by the loop's turn summary. */
export type TurnUsage = { input_tokens?: number; output_tokens?: number };

/**
 * The child loop's abort as an Effect: it settles with `outcome()` the moment
 * `signal` aborts, and never otherwise. Built per race, so the outcome is
 * constructed only when the abort actually fires.
 */
export function onceAborted<A, E>(
  signal: AbortSignal,
  outcome: () => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => {
    const detach = onAbort(signal, () => resume(outcome()));
    return Effect.sync(detach);
  });
}

/** Race a queue wait against the child loop's stop; null when stopped. */
export function untilInterrupted<A>(
  wait: Effect.Effect<A>,
  stop: AbortSignal,
): Effect.Effect<A | null> {
  return Effect.raceFirst(
    wait,
    onceAborted(stop, () => Effect.succeed(null)),
  ).pipe(Effect.interruptible);
}

/** Log a turn summary (duration + token usage) to the child stream. */
function logTurnSummary(
  logger: AgentTrace,
  wallTimeMs: number,
  usage: TurnUsage | null | undefined,
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info('Tokens', {
      data: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
    });
  }
}

/** Outcome of a single turn attempt, flattening the loop's inner try/catch. */
type TurnAttempt<TTurn> =
  | { kind: 'completed'; turn: TTurn; turnIsError: boolean }
  | { kind: 'failed'; err: unknown }
  | { kind: 'interrupted' };

/**
 * Run one turn (via `runner`) and classify the outcome. A clean interruption
 * maps to `interrupted` (the caller breaks), a thrown call to `failed`, and a
 * returned turn to `completed` (carrying its application-level error flag).
 */
export function attemptTurn<TTurn, R>(
  strategy: ChildRunStrategy<TTurn, R>,
  runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
  stop: AbortSignal,
  logger: AgentTrace,
  startedAt: number,
): Effect.Effect<TurnAttempt<TTurn>, never, R> {
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* runner(stop);
        logTurnSummary(
          logger,
          Date.now() - startedAt,
          strategy.getUsage?.(turn),
        );
        const turnIsError = strategy.isTurnError?.(turn) === true;
        if (turnIsError) strategy.onTurnError?.(turn, logger);
        return { kind: 'completed' as const, turn, turnIsError };
      }),
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    const caught = Cause.squash(attempt.cause);
    if (stop.aborted || isUserAbort(caught)) {
      return { kind: 'interrupted' as const };
    }
    logger.error(toErrorMessage(caught));
    return { kind: 'failed' as const, err: caught };
  });
}

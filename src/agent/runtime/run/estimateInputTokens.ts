/**
 * The live input-token count both preflight sites share: the estimate a
 * provider offers for a prepared foreground turn, read as a nullable so a
 * counting failure degrades instead of failing the caller.
 */
import { Cause, Effect, Exit } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { Model, ResolvedTurn } from '@llm/turn';

/**
 * The provider's counted input tokens for `turn`, or null where it offers no
 * counter or the count failed. A failure is logged at debug with
 * `failureMessage` (each caller names what proceeds without the count) and
 * the run continues; the provider enforces its own limit. Interruption stays
 * an interrupt.
 */
export const estimateInputTokensOrNull = Effect.fn('estimateInputTokensOrNull')(
  function* (
    model: Model,
    turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
    logger: AgentTrace,
    failureMessage: string,
  ) {
    if (!model.estimateInputTokens) return null;
    const estimate = yield* Effect.exit(model.estimateInputTokens(turn));
    if (Exit.isFailure(estimate)) {
      if (Cause.hasInterrupts(estimate.cause)) return yield* Effect.interrupt;
      logger.debug(failureMessage, { data: Cause.squash(estimate.cause) });
      return null;
    }
    return estimate.value.inputTokens;
  },
);

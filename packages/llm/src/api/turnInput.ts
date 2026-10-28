// Third-party imports
import { Effect, Result, Schema } from 'effect';

// Local imports - canonical model contract
import {
  ResolvedTurnSchema,
  TurnRequestSchema,
  type AnthropicMessagesConfiguration,
  type Model,
  type ResolvedTurn,
  type TurnRequest,
} from '../turn.js';
import { ModelError } from '../errors.js';
import type { ModelOrigin } from '../protocol.js';

/**
 * Prepares a turn on the `origin` binding: revalidates the authored request,
 * refuses a continuation another protocol issued and a background turn on a
 * model without the `background` member, decodes the turn `resolve` builds,
 * and lowers it once with `lower`, so an unrepresentable turn fails here
 * rather than at transport. Every refusal is a typed `ModelError`.
 */
export const resolveTurn = Effect.fn('llm.resolveTurn')(function* (
  request: TurnRequest,
  origin: ModelOrigin,
  background: Model['background'],
  resolve: (input: TurnRequest) => Effect.Effect<unknown, ModelError>,
  lower: (turn: ResolvedTurn) => Effect.Effect<unknown, ModelError>,
) {
  const decoded = Schema.decodeUnknownResult(TurnRequestSchema)(request);
  if (!Result.isSuccess(decoded))
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The turn request is invalid.',
      cause: decoded.failure,
    });
  const input = decoded.success;
  if (
    input.continuation !== undefined &&
    input.continuation.origin.protocol !== origin.protocol
  )
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The continuation belongs to another protocol.',
    });
  if (input.mode === 'background' && background === undefined)
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The model does not run background turns.',
    });
  const turn = Schema.decodeUnknownResult(ResolvedTurnSchema)(
    yield* resolve(input),
  );
  if (!Result.isSuccess(turn))
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The request resolves to no supported turn.',
      cause: turn.failure,
    });
  yield* lower(turn.success);
  return turn.success;
});

/**
 * An Anthropic request's output limit and the thinking that fits below it: a
 * manual budget at or above a smaller requested limit (a summary sized to
 * the context left) is left off that request rather than refused.
 */
export function fitLimit(
  defaults: AnthropicMessagesConfiguration['defaults'],
  requested: number | undefined,
) {
  const maxOutputTokens = requested ?? defaults.maxOutputTokens;
  const { thinking } = defaults;
  const fits =
    thinking.mode !== 'enabled' || thinking.budgetTokens < maxOutputTokens;
  return {
    maxOutputTokens,
    thinking: fits ? thinking : ({ mode: 'disabled' } as const),
  };
}

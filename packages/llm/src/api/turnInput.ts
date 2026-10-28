// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports - canonical model contract
import {
  ResolvedTurnSchema,
  TurnRequestSchema,
  type AnthropicMessagesConfiguration,
  type ResolvedTurn,
  type TurnRequest,
} from '../turn.js';
import { ModelError } from '../errors.js';

/** A decode whose failure is an `invalid-request` naming the adapter's message. */
const decodeOrInvalid =
  <T>(schema: Schema.Codec<T, unknown>) =>
  (message: string, value: unknown): Effect.Effect<T, ModelError> =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) => new ModelError({ kind: 'invalid-request', message, cause }),
      ),
    );

/** Revalidates authored input; each adapter names its own invalid-request message. */
export const decodeTurnRequest: (
  message: string,
  request: TurnRequest,
) => Effect.Effect<TurnRequest, ModelError> =
  decodeOrInvalid(TurnRequestSchema);

/**
 * The one decode of a prepared turn, for every protocol: a turn the binding's
 * controls cannot complete is an `invalid-request` failure naming `message`,
 * never a defect.
 */
export const resolveTurn: (
  message: string,
  turn: unknown,
) => Effect.Effect<ResolvedTurn, ModelError> =
  decodeOrInvalid(ResolvedTurnSchema);

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

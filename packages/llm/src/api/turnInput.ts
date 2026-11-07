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
import { sameModelOrigin, type ModelOrigin } from '../protocol.js';

/**
 * Prepares a turn on the `origin` binding: revalidates the authored request,
 * refuses a continuation another protocol issued, a background turn on a
 * model without the `background` member and a forced tool the request does
 * not define, completes the request with the `controls` (and `transport`)
 * `resolve` builds, and lowers it once with `lower`, so an unrepresentable
 * turn fails here rather than at transport. Every refusal is a typed
 * `ModelError`.
 */
export const resolveTurn = Effect.fn('llm.resolveTurn')(function* (
  request: TurnRequest,
  origin: ModelOrigin,
  background: Model['background'],
  resolve: (
    input: TurnRequest,
  ) => Effect.Effect<
    { readonly controls: object; readonly transport?: object },
    ModelError
  >,
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
      kind: 'invalid-request',
      message: 'The continuation belongs to another protocol.',
    });
  if (input.mode === 'background' && background === undefined)
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The model does not run background turns.',
    });
  const toolChoice = input.toolChoice ?? 'auto';
  const tools = input.tools ?? [];
  if (toolChoice !== 'auto' && !tools.some((t) => t.name === toolChoice.name))
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The required tool must be present in the supplied definitions.',
    });
  const { controls, ...resolved } = yield* resolve(input);
  // A protocol without continuations drops the field as undeclared.
  const turn = Schema.decodeUnknownResult(ResolvedTurnSchema)({
    ...origin,
    mode: input.mode ?? 'foreground',
    system: input.system,
    messages: input.messages,
    tools,
    continuation: input.continuation,
    controls: { toolChoice, ...controls },
    ...resolved,
  });
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
 * `turn`, provided the `origin` binding prepared it for `mode`. The origin
 * comparison includes the protocol.
 */
export function boundTurn<
  P extends ResolvedTurn['protocol'],
  M extends ResolvedTurn['mode'],
>(
  turn: ResolvedTurn,
  origin: ModelOrigin & { readonly protocol: P },
  mode: M,
): Effect.Effect<Extract<ResolvedTurn, { protocol: P; mode: M }>, ModelError> {
  const bound = (
    candidate: ResolvedTurn,
  ): candidate is Extract<ResolvedTurn, { protocol: P; mode: M }> =>
    candidate.mode === mode && sameModelOrigin(candidate, origin);
  return bound(turn)
    ? Effect.succeed(turn)
    : Effect.fail(
        new ModelError({
          kind: 'invalid-request',
          message:
            'The prepared turn belongs to another model binding or execution mode.',
        }),
      );
}

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

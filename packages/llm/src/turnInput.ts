// Third-party imports
import { Effect } from 'effect';

// Local imports - canonical model contract
import {
  TurnRequestSchema,
  type AnthropicMessagesConfiguration,
  type TurnRequest,
} from './turn.js';
import { ModelError } from './errors.js';

/** Revalidates authored input; each adapter names its own invalid-request message. */
export const decodeTurnRequest = (
  request: TurnRequest,
  message: string,
): Effect.Effect<TurnRequest, ModelError> => {
  const parsed = TurnRequestSchema.safeParse(request);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new ModelError({
          kind: 'invalid-request',
          message,
          cause: parsed.error,
        }),
      );
};

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

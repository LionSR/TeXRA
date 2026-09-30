// Third-party imports
import { Effect } from 'effect';

// Local imports - canonical model contract
import {
  TurnRequestSchema,
  type AnthropicMessagesConfiguration,
  type ResolvedTurn,
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
 * The text parts of a turn that is one initial text-only user message with no
 * tools or continuation, the only input a provider count admits; otherwise
 * `undefined`.
 */
export function initialTextInput(turn: {
  readonly messages: ResolvedTurn['messages'];
  readonly tools: ResolvedTurn['tools'];
  readonly continuation?: unknown;
}) {
  const [message, ...rest] = turn.messages;
  if (
    turn.continuation !== undefined ||
    turn.tools.length !== 0 ||
    rest.length !== 0 ||
    message?.role !== 'user'
  )
    return undefined;
  const text = message.content.filter((part) => part.kind === 'text');
  return text.length === message.content.length ? text : undefined;
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

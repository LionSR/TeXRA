// Third-party imports
import { Effect } from 'effect';

// Local imports - canonical model errors
import { ModelError } from './errors.js';

// Local imports - canonical model contract
import type { TurnEvent, TurnResult } from './turn.js';

/**
 * The canonical counts a Chat completion receipt reports under the documented
 * OpenAI-compatible field names, which every route in this protocol family
 * shares. An absent count is unreported, never a zero, and a route's own
 * additional receipts stay with the route that reads them.
 */
export const chatUsageCounts = (receipt: {
  readonly prompt_tokens?: number | null;
  readonly completion_tokens?: number | null;
  readonly total_tokens?: number | null;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: number | null;
  } | null;
  readonly completion_tokens_details?: {
    readonly reasoning_tokens?: number | null;
  } | null;
}): NonNullable<TurnResult['usage']> => ({
  inputTokens: receipt.prompt_tokens ?? null,
  outputTokens: receipt.completion_tokens ?? null,
  totalTokens: receipt.total_tokens ?? null,
  cachedInputTokens: receipt.prompt_tokens_details?.cached_tokens ?? null,
  reasoningTokens: receipt.completion_tokens_details?.reasoning_tokens ?? null,
});

/** A tool call rebuilt from the fragments one stream reported for its index. */
type ChatToolCall = {
  id?: string;
  name?: string;
  type?: 'function';
  arguments: string;
};

/** One streamed tool-call fragment, as every Chat delta grammar spells it. */
type ChatToolCallFragment = {
  readonly index: number;
  readonly id?: string | null;
  readonly type?: 'function' | null;
  readonly function?: {
    readonly name?: string | null;
    readonly arguments?: string | null;
  };
};

/** The visible text one delta may carry, emitted in this declared order. */
type ChatVisibleDelta = {
  readonly reasoning?: string | null;
  readonly text?: string | null;
  readonly refusal?: string | null;
};

/** Coalesced assistant output: consecutive deltas of one kind are one part. */
type ChatTextPart = { kind: 'text' | 'refusal'; text: string };

/**
 * The accumulated assistant output every Chat delta stream builds the same
 * way: which reasoning or text phase is open, the coalesced text and refusal
 * parts, and the tool calls assembled from fragments reported by index. One
 * accumulator belongs to one streamed response, and the events its methods
 * return are the events that response emits, in order.
 */
export const chatDeltaAccumulator = () => {
  let activePhase: 'reasoning' | 'text' | undefined;
  const parts: ChatTextPart[] = [];
  const calls = new Map<number, ChatToolCall>();

  /** End the open phase, if one is open; tool calls and EOF both close it. */
  const closePhase = (): TurnEvent[] => {
    if (activePhase === undefined) return [];
    const ended: TurnEvent = {
      kind: 'phase',
      part: activePhase,
      boundary: 'end',
      providerItemIndex: null,
    };
    activePhase = undefined;
    return [ended];
  };

  return Object.freeze({
    /** The coalesced visible parts, in arrival order. */
    parts: parts as readonly ChatTextPart[],
    closePhase,
    /** Absorb one delta's visible text, returning its phase and delta events. */
    absorbText: (delta: ChatVisibleDelta): TurnEvent[] => {
      const events: TurnEvent[] = [];
      for (const [part, text] of [
        ['reasoning', delta.reasoning],
        ['text', delta.text],
        ['refusal', delta.refusal],
      ] as const) {
        if (text == null || text === '') continue;
        const phase = part === 'reasoning' ? 'reasoning' : 'text';
        if (activePhase !== phase) {
          events.push(...closePhase());
          events.push({
            kind: 'phase',
            part: phase,
            boundary: 'start',
            providerItemIndex: null,
          });
          activePhase = phase;
        }
        if (part !== 'reasoning') {
          const previous = parts.at(-1);
          if (previous?.kind === part) previous.text += text;
          else parts.push({ kind: part, text });
        }
        events.push({ kind: 'delta', part, text, providerItemIndex: null });
      }
      return events;
    },
    /**
     * Absorb one delta's tool-call fragments. A fragment that restates an
     * identity must restate the same one; `changedIdentity` names that failure
     * in the reporting provider's own words.
     */
    absorbToolCalls: (
      fragments: readonly ChatToolCallFragment[] | null | undefined,
      changedIdentity: string,
    ): Effect.Effect<void, ModelError> =>
      Effect.gen(function* () {
        for (const fragment of fragments ?? []) {
          const call = calls.get(fragment.index) ?? { arguments: '' };
          if (
            (fragment.id != null &&
              call.id !== undefined &&
              fragment.id !== call.id) ||
            (fragment.function?.name != null &&
              call.name !== undefined &&
              fragment.function.name !== call.name)
          ) {
            return yield* new ModelError({
              kind: 'malformed-output',
              message: changedIdentity,
            });
          }
          call.id = fragment.id ?? call.id;
          call.name = fragment.function?.name ?? call.name;
          call.type = fragment.type ?? call.type;
          // The provider's own argument bytes, never a re-encoded parse.
          call.arguments += fragment.function?.arguments ?? '';
          calls.set(fragment.index, call);
        }
      }),
    /** The accumulated calls paired with the index each was reported under. */
    toolCalls: (): readonly (readonly [number, ChatToolCall])[] =>
      [...calls].toSorted(([left], [right]) => left - right),
  });
};

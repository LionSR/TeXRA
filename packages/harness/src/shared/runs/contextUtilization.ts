import type { Schema } from 'effect';

import type { HistoryMessage } from '@shared/session/historyTurns';

/**
 * Rounded percentage of the context window consumed by `tokens`. Single
 * source for the rounded log/display value so every surface reports the same
 * precision (1 decimal).
 */
export function roundedUtilizationPercent(
  tokens: number,
  contextWindow: number,
): number {
  return Number(((tokens / contextWindow) * 100).toFixed(1));
}

/**
 * What one media part adds to the estimate. History holds a part by its
 * address alone, with no size, page count or duration, so every kind counts
 * as one image, sized from provider figures:
 * - image: providers scale an image down to a fixed budget. Anthropic counts
 *   about width × height / 750 tokens and scales an image over about 1.15
 *   megapixels down, so one costs at most about 1,600.
 * - document: a PDF is sent as an image of each page plus the page's text,
 *   1,500 to 3,000 tokens a page on Anthropic. With no page count it counts
 *   as one page, so a long PDF counts for far less than it costs. A PDF sent
 *   as page images instead counts per page, as images.
 * - audio and video: they cost more the longer they run (Gemini counts 32
 *   tokens a second of audio). With no length, they count as one image.
 * A provider's count holds the media its request carried: while there is
 * one, only the parts after it are estimated.
 */
const MEDIA_PART_TOKENS = 1_600;

/** The text a model reads at the standard ~4 characters a token, plus
 *  {@link MEDIA_PART_TOKENS} for each media part; reasoning does not count.
 *  The figure before any model has counted the text: a run's own counts
 *  correct it ({@link tokenRate}). */
export function estimateMessageTokens(
  messages: readonly HistoryMessage[],
): number {
  let chars = 0;
  let media = 0;
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        chars += message.text.length;
        break;
      case 'user':
      case 'tool': {
        const parts =
          message.role === 'user'
            ? message.content
            : message.results.flatMap(({ content }) => content);
        for (const part of parts) {
          if (part.kind === 'text') chars += part.text.length;
          else media += 1;
        }
        break;
      }
      case 'assistant':
        for (const part of message.content) {
          if (part.kind === 'local-call') chars += part.argumentsText.length;
          else if (part.kind === 'message') {
            for (const piece of part.content) chars += piece.text.length;
          }
        }
        break;
    }
  }
  return Math.ceil(chars / 4) + media * MEDIA_PART_TOKENS;
}

/** The estimate of content a request sends beside its messages (the system
 *  text, a tool's declaration), as the run stores it by address. */
export function estimateContentTokens(value: Schema.Json | undefined): number {
  if (value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

/** The bounds a measured rate is held to: no tokenizer reads text at under
 *  an eighth of the estimate or over eight times it (text of one-character
 *  tokens is four), so a figure outside them is a count that measured
 *  something else. */
const RATE_BOUNDS = { minimum: 0.125, maximum: 8 } as const;

/**
 * How many tokens the run's model counts for each token the estimate
 * gives: the last response's provider-counted input over the estimate of
 * what that request held, the offered text and the messages before the
 * response's own. Tokenizers differ, and text that is not English prose
 * (another script, LaTeX, code) is far from four characters a token, so the
 * estimate alone can be several times off. While no count measures the
 * view (none yet, or an edit changed it since), it is the rate the run last
 * measured (`measured`).
 */
export function tokenRate(state: {
  readonly messages: readonly HistoryMessage[];
  readonly lastTurn: {
    readonly usage: { readonly inputTokens: number | null } | null;
  } | null;
  readonly countStale: boolean;
  readonly pendingResponse: unknown;
  readonly offeredEstimate: number;
  readonly measuredRate: number;
}): number {
  const input = state.lastTurn?.usage?.inputTokens ?? null;
  if (state.countStale || input === null || input <= 0)
    return state.measuredRate;
  // The response's own message enters the history with its delivery; after
  // it, the last assistant message is that one and the request held what
  // comes before it.
  const own =
    state.pendingResponse !== null
      ? -1
      : state.messages.findLastIndex(({ role }) => role === 'assistant');
  const estimate =
    state.offeredEstimate +
    estimateMessageTokens(
      own === -1 ? state.messages : state.messages.slice(0, own),
    );
  if (estimate <= 0) return state.measuredRate;
  return Math.min(
    RATE_BOUNDS.maximum,
    Math.max(RATE_BOUNDS.minimum, input / estimate),
  );
}

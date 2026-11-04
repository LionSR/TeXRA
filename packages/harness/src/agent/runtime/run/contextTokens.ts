/**
 * The run's one context-size fact: the tokens its history occupies, read by
 * the compaction trigger, the context gauge and the output-budget preflight
 * (`outputBudget`). Derived
 * from the run state, never stored: the last response's provider-counted
 * input plus output, then an estimate of the messages added since. Before the
 * first response, and after a compaction replaced the history, it is that
 * estimate alone.
 */
import type { HistoryMessage } from '@shared/session/historyTurns';
import type { RunState } from '@shared/session/runState';
import type { BoundModel } from '../modelAccess/ModelAccess';

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
 *  {@link MEDIA_PART_TOKENS} for each media part; reasoning does not count. */
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

export function contextTokens(
  state: Pick<
    RunState,
    'messages' | 'lastTurn' | 'countStale' | 'pendingResponse'
  >,
): number {
  const { usage } = state.lastTurn ?? {};
  // An edit that changed the view since the counted turn (a compaction that
  // kept the turns after its range) leaves the count measuring a history
  // the view no longer holds: the estimate alone measures it.
  const counted =
    !state.countStale && usage?.inputTokens != null && usage.inputTokens > 0
      ? usage.inputTokens + (usage.outputTokens ?? 0)
      : null;
  if (counted === null) return estimateMessageTokens(state.messages);
  // A response's own message enters the history with its delivery, so until
  // then nothing follows the counted turn.
  if (state.pendingResponse !== null) return counted;
  // After it, the last assistant message is the one `lastTurn` counted and
  // what follows is the delta. A history with none is a compaction's
  // replacement, whose `lastTurn` is a turn it no longer holds.
  const at = state.messages.findLastIndex(({ role }) => role === 'assistant');
  return at === -1
    ? estimateMessageTokens(state.messages)
    : counted + estimateMessageTokens(state.messages.slice(at + 1));
}

/**
 * The output-budget preflight's constants: the buffer covers tokenization
 * differences and API framing, and a reduction below the floor is not worth
 * taking.
 */
const TOKEN_SAFETY_BUFFER = 10;
const TOOL_USE_SAFETY_BUFFER = 2000;
const MIN_COMPLETION_TOKENS = 100;

/** The output budget that fits in what the input leaves of the window. */
function reducedOutputBudget(available: number, buffer: number): number {
  if (available <= 0) return 1;
  const buffered = available - buffer;
  return buffered >= MIN_COMPLETION_TOKENS ? buffered : available;
}

/**
 * What the model's window leaves a request, from the run's context size: an
 * input that alone exceeds the window is refused before it is billed
 * (`overflow`); one leaving too little room for the binding's output limit
 * asks for a smaller output (`reduced`) rather than let the provider reject
 * it. Null when the window is unknown or the request fits as it is.
 */
export function outputBudget(
  state: Parameters<typeof contextTokens>[0],
  bound: Pick<BoundModel, 'config' | 'maxOutputTokens' | 'textOnly'>,
):
  | { readonly kind: 'overflow'; readonly inputTokens: number }
  | {
      readonly kind: 'reduced';
      readonly inputTokens: number;
      readonly limit: number;
      readonly maxOutputTokens: number;
    }
  | null {
  const { contextWindow } = bound.config;
  if (contextWindow <= 0) return null;
  const inputTokens = contextTokens(state);
  if (inputTokens > contextWindow) return { kind: 'overflow', inputTokens };
  const limit = bound.maxOutputTokens;
  if (limit === null || inputTokens + limit <= contextWindow) return null;
  const maxOutputTokens = reducedOutputBudget(
    contextWindow - inputTokens,
    bound.textOnly ? TOKEN_SAFETY_BUFFER : TOOL_USE_SAFETY_BUFFER,
  );
  return { kind: 'reduced', inputTokens, limit, maxOutputTokens };
}

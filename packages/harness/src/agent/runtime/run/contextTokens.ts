/**
 * The run's one context-size fact: the tokens its history occupies, read by
 * the compaction trigger, the context gauge and the output-budget preflight
 * (`outputBudget`). Derived
 * from the run state, never stored: the last response's provider-counted
 * input plus output, then an estimate of the messages added since. Before the
 * first response, and after an edit changed the view, it is the estimate of
 * what the next request sends, the offered text and the messages. Every
 * estimate is at the rate the run's model last counted (`tokenRate`).
 */
import {
  estimateMessageTokens,
  tokenRate,
} from '@shared/runs/contextUtilization';
import type { RunState } from '@shared/session/runState';
import type { BoundModel } from '../modelAccess/ModelAccess';

export function contextTokens(
  state: Pick<
    RunState,
    | 'messages'
    | 'lastTurn'
    | 'countStale'
    | 'pendingResponse'
    | 'offeredEstimate'
    | 'measuredRate'
  >,
): number {
  const { usage } = state.lastTurn ?? {};
  const rate = tokenRate(state);
  const estimated = (messages: RunState['messages']) =>
    Math.ceil(rate * estimateMessageTokens(messages));
  // An edit that changed the view since the counted turn (a compaction that
  // kept the turns after its range) leaves the count measuring a history
  // the view no longer holds: the estimate alone measures it.
  const counted =
    !state.countStale && usage?.inputTokens != null && usage.inputTokens > 0
      ? usage.inputTokens + (usage.outputTokens ?? 0)
      : null;
  const whole = () =>
    Math.ceil(rate * state.offeredEstimate) + estimated(state.messages);
  if (counted === null) return whole();
  // A response's own message enters the history with its delivery, so until
  // then nothing follows the counted turn.
  if (state.pendingResponse !== null) return counted;
  // After it, the last assistant message is the one `lastTurn` counted and
  // what follows is the delta. A history with none is a compaction's
  // replacement, whose `lastTurn` is a turn it no longer holds.
  const at = state.messages.findLastIndex(({ role }) => role === 'assistant');
  return at === -1
    ? whole()
    : counted + estimated(state.messages.slice(at + 1));
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

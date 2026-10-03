/**
 * The run's one context-size fact: the tokens its history occupies, read by
 * the compaction trigger, the context gauge and the request clamp. Derived
 * from the folded state, never stored: the last response's provider-counted
 * input plus output, then a characters-per-four estimate of the messages
 * added since. Before the first response, and after a compaction replaced the
 * history, it is that estimate alone.
 */
import type { HistoryMessage } from '@shared/session/historyTurns';
import type { RunState } from '@shared/session/runStateFold';

/** The text a model reads at the standard ~4 characters a token; media and reasoning do not count. */
export function estimateMessageTokens(
  messages: readonly HistoryMessage[],
): number {
  let chars = 0;
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        chars += message.text.length;
        break;
      case 'user':
        for (const part of message.content) {
          if (part.kind === 'text') chars += part.text.length;
        }
        break;
      case 'tool':
        for (const { content } of message.results) {
          for (const part of content) {
            if (part.kind === 'text') chars += part.text.length;
          }
        }
        break;
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
  return Math.ceil(chars / 4);
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

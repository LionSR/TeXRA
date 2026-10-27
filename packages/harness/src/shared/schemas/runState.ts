import { Schema } from 'effect';

// Conversation Progress (tool-call counters updated during run)

/**
 * The payload of a `conversation.progress` row: how many tool calls a run has
 * made so far. The run emits it from its progress callback as the count
 * grows; the session view shows it per run and the transcript leaves it out.
 */
export const ConversationProgressSchema = Schema.Struct({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: Schema.Number,
});

import { Schema } from 'effect';

// Conversation Progress (tool-call counters updated during run)

export const ConversationProgressSchema = Schema.Struct({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: Schema.Number,
});

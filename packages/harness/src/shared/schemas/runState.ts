import { z } from 'zod';

// Conversation Progress (tool-call counters updated during run)

export const ConversationProgressSchema = z.object({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number(),
});

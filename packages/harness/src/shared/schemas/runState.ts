import { z } from 'zod';

// Round Stage (the round an output or a diff names)

const RoundStageSchema = z.object({
  /** Zero-based round index. */
  index: z.int().nonnegative(),
});

export type RoundStage = z.infer<typeof RoundStageSchema>;

// Conversation Progress (tool-call counters updated during run)

export const ConversationProgressSchema = z.object({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number(),
});

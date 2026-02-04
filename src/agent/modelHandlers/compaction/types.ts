/**
 * Types for context compaction.
 */

import { z } from 'zod';

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  /** Whether compaction was performed */
  compacted: boolean;
  /** The summary text generated (only if compacted) */
  summary?: string;
  /** Token count before compaction */
  tokensBefore?: number;
  /** Token count after compaction (the summary's token count) */
  tokensAfter?: number;
  /** The model used for compaction */
  compactionModel?: string;
}

/**
 * State of compaction for a conversation.
 * Stored in agent execution state.
 */
export const CompactionStateSchema = z.object({
  /** The generated summary text */
  summary: z.string(),
  /** When compaction occurred (Unix timestamp) */
  timestamp: z.number(),
  /** Token count before compaction */
  tokensBefore: z.number(),
  /** Token count after compaction */
  tokensAfter: z.number(),
  /** Model used for compaction */
  compactionModel: z.string(),
  /** Number of times compaction has occurred in this conversation */
  compactionCount: z.number().default(1),
});

export type CompactionState = z.infer<typeof CompactionStateSchema>;

/**
 * Options for performing compaction.
 */
export interface CompactionOptions {
  /** The compaction threshold in tokens (usually % of context window) */
  threshold: number;
  /** The model to use for generating summaries */
  compactionModel: string;
  /** Context window size for utilization calculations */
  contextWindow: number;
}

/**
 * Internal result from summarization call.
 */
export interface SummarizationResult {
  /** The summary text */
  summary: string;
  /** Input tokens used in the summarization call */
  inputTokens: number;
  /** Output tokens used in the summarization call */
  outputTokens: number;
}

import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import { roundIndexedRecord } from './roundIndexed';

// Round Stage (ephemeral round label from typed stage.start metadata)

const RoundStageSchema = z.object({
  /** Zero-based round/turn index. */
  index: z.int().nonnegative(),
  /** Planned total, when known. Reflection workflows set this. */
  total: z.int().positive().optional(),
});

export type RoundStage = z.infer<typeof RoundStageSchema>;

// Conversation Progress (tool-call counters updated during run)

export const ConversationProgressSchema = z.object({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number().prefault(0),
});

export type ConversationProgress = z.infer<typeof ConversationProgressSchema>;

export const ApprovalBypassesSchema = z.record(
  z.enum(APPROVAL_BYPASS_KINDS),
  z.boolean(),
);

export const RoundKeyedOutputSidecarValueSchemas = {
  outputFiles: roundIndexedRecord(OutputFileInfoSchema),
  missingOutputs: roundIndexedRecord(z.string()),
  compileFailures: roundIndexedRecord(CompileFailureSchema),
} as const;

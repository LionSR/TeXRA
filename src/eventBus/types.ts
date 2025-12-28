/**
 * Shared event bus types for breaking circular dependency with progressView.
 */
import { z } from 'zod';
import { StreamTabIdSchema } from '@agent/types/IdentifierTypes';

/** Tool edit approval request prompt */
export const ToolEditApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  allowBypass: z.boolean(),
  streamId: z.union([StreamTabIdSchema, z.literal('')]),
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
});
export type ToolEditApprovalPrompt = z.infer<
  typeof ToolEditApprovalPromptSchema
>;

/** Manual retry request prompt */
export const RetryRequestPromptSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type RetryRequestPrompt = z.infer<typeof RetryRequestPromptSchema>;

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
  isLatex: z.boolean(),
});
export type ToolEditApprovalPrompt = z.infer<
  typeof ToolEditApprovalPromptSchema
>;

/** Manual retry request prompt */
export const RetryErrorDetailsSchema = z.strictObject({
  provider: z.string().optional(),
  statusCode: z.int().optional(),
  /** Whether the error is retryable (user can click retry button). */
  retryable: z.boolean().optional(),
  /** Whether the error originated from the relay service. */
  isRelayError: z.boolean().optional(),
  rawErrorBody: z.unknown().optional(),
});
export type RetryErrorDetails = z.infer<typeof RetryErrorDetailsSchema>;

export const RetryRequestPromptSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: RetryErrorDetailsSchema.optional(),
});
export type RetryRequestPrompt = z.infer<typeof RetryRequestPromptSchema>;

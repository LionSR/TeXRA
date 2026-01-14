/**
 * Shared event bus types for breaking circular dependency with progressView.
 */
import { z } from 'zod';
import { StreamTabIdSchema } from '@agent/types/IdentifierTypes';

// Import canonical error schema - SINGLE SOURCE OF TRUTH
// schemas.ts has no internal project imports, so no circular dependency risk
import {
  ProviderErrorPartialSchema,
  type ProviderErrorPartial,
} from '@common/errors/schemas';

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

/**
 * Error details for retry requests.
 * Uses ProviderErrorPartialSchema from canonical source - all fields optional for transport.
 */
export const RetryErrorDetailsSchema = ProviderErrorPartialSchema;
export type RetryErrorDetails = ProviderErrorPartial;

export const RetryRequestPromptSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: RetryErrorDetailsSchema.optional(),
});
export type RetryRequestPrompt = z.infer<typeof RetryRequestPromptSchema>;

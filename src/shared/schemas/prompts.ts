// Third-party imports
import { z } from 'zod';

// Local imports - identifiers
import { StreamTabIdSchema } from './identifiers';

// Local imports - error schemas
import { ProviderErrorPartialSchema } from './errors';

/**
 * Optional stream ID schema - allows empty string for cases where stream context
 * may not be available (e.g., approval requests during initialization).
 */
export const OptionalStreamIdSchema = z.union([
  StreamTabIdSchema,
  z.literal(''),
]);
export type OptionalStreamId = z.infer<typeof OptionalStreamIdSchema>;

/** Tool edit approval request prompt */
export const ToolEditApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  allowBypass: z.boolean(),
  streamId: OptionalStreamIdSchema,
  addedLines: z.int().nonnegative(),
  removedLines: z.int().nonnegative(),
  isLatex: z.boolean(),
});
export type ToolEditApprovalPrompt = z.infer<
  typeof ToolEditApprovalPromptSchema
>;

/** Bash approval request prompt */
export const BashApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  command: z.string(),
  allowBypass: z.boolean(),
  streamId: OptionalStreamIdSchema,
});
export type BashApprovalPrompt = z.infer<typeof BashApprovalPromptSchema>;

export const RetryRequestPromptSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
  errorDetails: ProviderErrorPartialSchema.optional(),
});
export type RetryRequestPrompt = z.infer<typeof RetryRequestPromptSchema>;

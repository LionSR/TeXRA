/**
 * Shared types for the progress event bus.
 *
 * These types are used by both the event bus and UI components.
 * They are defined here to break the circular dependency between
 * @eventBus and @progressView.
 */

// Third-party imports
import { z } from 'zod';

// Type imports
import { StreamTabIdSchema } from '@agent/types/IdentifierTypes';

// ============================================================================
// EVENT PAYLOAD SCHEMAS (types derived via z.infer)
// ============================================================================

/**
 * Prompt data for tool edit approval requests.
 * Emitted via 'showToolEditApprovalPrompt' event.
 */
export const ToolEditApprovalPromptSchema = z.strictObject({
  requestId: z.string(),
  path: z.string(),
  relativePath: z.string(),
  sourceTool: z.string(),
  allowBypass: z.boolean(),
  streamId: z.union([StreamTabIdSchema, z.literal('')]),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
});
export type ToolEditApprovalPrompt = z.infer<
  typeof ToolEditApprovalPromptSchema
>;

/**
 * Prompt data for manual retry requests.
 * Emitted via 'showRetryRequest' event.
 */
export const RetryRequestPromptSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  operation: z.string(),
  model: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type RetryRequestPrompt = z.infer<typeof RetryRequestPromptSchema>;

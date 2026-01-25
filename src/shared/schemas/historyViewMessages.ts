/**
 * History view message schemas.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - webview commands
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands';

// =============================================================================
// Data Schemas
// =============================================================================

const AgentConfigSummarySchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  agentCategory: z.enum(['workflow', 'toolUse']).optional(),
  inputFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  mediaFile: z.string().optional(),
  mediaFiles: z.array(z.string()).optional(),
  referenceFile: z.string().optional(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFile: z.string().optional(),
  auxiliaryFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
  toolConfig: z.record(z.string(), z.unknown()).optional(),
});

export const HistoryItemSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  agentConfig: AgentConfigSummarySchema,
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

// =============================================================================
// Backend → Frontend Messages
// =============================================================================

export const UpdateHistoryMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.UPDATE_HISTORY),
  historyItems: z.array(HistoryItemSchema),
});
export type UpdateHistoryMessage = z.infer<typeof UpdateHistoryMessageSchema>;

export const HistoryClearedMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.HISTORY_CLEARED),
});
export type HistoryClearedMessage = z.infer<typeof HistoryClearedMessageSchema>;

/**
 * Schema definitions for HistoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_HISTORY, HISTORY_CLEARED)
 * Inbound: Frontend → Backend (GET_HISTORY_DATA, RERUN_AGENT, etc.)
 */
import { z } from 'zod';

import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands';
import { commandOnly } from './messageFactories';

import { AGENT_CATEGORY } from './agent';

// ============================================================
// Data schemas
// ============================================================

/** Fields shared by all agent categories. */
const BaseConfigSummarySchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
});

/** Workflow agents carry file-related fields. */
const WorkflowConfigSummarySchema = BaseConfigSummarySchema.extend({
  agentCategory: z.literal(AGENT_CATEGORY.WORKFLOW),
  inputFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
  toolConfig: z.record(z.string(), z.unknown()).nullish(),
});

/** Tool-use agents only have the base fields. */
const ToolUseConfigSummarySchema = BaseConfigSummarySchema.extend({
  agentCategory: z.literal(AGENT_CATEGORY.TOOL_USE),
});

const AgentConfigSummarySchema = z.discriminatedUnion('agentCategory', [
  WorkflowConfigSummarySchema,
  ToolUseConfigSummarySchema,
]);

export const HistoryItemSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  agentConfig: AgentConfigSummarySchema,
  /** AI-generated summary of what the session aimed to accomplish. */
  description: z.string().optional(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateHistoryMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.UPDATE_HISTORY),
  historyItems: z.array(HistoryItemSchema),
});
export type UpdateHistoryMessage = z.infer<typeof UpdateHistoryMessageSchema>;

export const HistoryClearedMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.HISTORY_CLEARED),
});
export type HistoryClearedMessage = z.infer<typeof HistoryClearedMessageSchema>;

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** History ID field for operations on specific items */
export const HistoryIdMessageSchema = z.object({
  historyId: z.string().min(1),
});
export type HistoryIdMessage = z.infer<typeof HistoryIdMessageSchema>;

export const GetHistoryDataMessageSchema = commandOnly(
  HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA,
);

export const RerunAgentMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.RERUN_AGENT),
  historyId: z.string().min(1),
});

export const RestoreAgentMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.RESTORE_AGENT),
  historyId: z.string().min(1),
});

export const DeleteAgentMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.DELETE_AGENT),
  historyId: z.string().min(1),
});

export const ClearHistoryMessageSchema = commandOnly(
  HISTORY_VIEW_COMMANDS.CLEAR_HISTORY,
);

export const ExportChatMdMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.EXPORT_CHAT_MD),
  historyId: z.string().min(1),
});

export const ExportChatTexMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.EXPORT_CHAT_TEX),
  historyId: z.string().min(1),
});

export const ExportChatHtmlMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.EXPORT_CHAT_HTML),
  historyId: z.string().min(1),
});

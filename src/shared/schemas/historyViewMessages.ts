/**
 * Schema definitions for HistoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_HISTORY, HISTORY_CLEARED)
 * Inbound: Frontend → Backend (RERUN_AGENT, RESTORE_AGENT, etc.)
 */
import { z } from 'zod';

import { HISTORY_VIEW_COMMANDS } from '@shared/ipc';
import { commandOnly } from './messageFactories';

import { AgentCategory } from './agent';
import { ToolConfigSchema } from './toolConfig';

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
  agentCategory: z.literal(AgentCategory.Workflow),
  inputFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
  toolConfig: ToolConfigSchema.nullish(),
});

/** Tool-use agents only have the base fields. */
const ToolUseConfigSummarySchema = BaseConfigSummarySchema.extend({
  agentCategory: z.literal(AgentCategory.ToolUse),
  editedFiles: z.array(z.string()).optional(),
});

const AgentConfigSummarySchema = z.discriminatedUnion('agentCategory', [
  WorkflowConfigSummarySchema,
  ToolUseConfigSummarySchema,
]);

const HistoryItemSchema = z.object({
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

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** History ID field for operations on specific items */
const HistoryIdMessageSchema = z.object({
  historyId: z.string().min(1),
});

export const RerunAgentMessageSchema = HistoryIdMessageSchema.extend({
  command: z.literal(HISTORY_VIEW_COMMANDS.RERUN_AGENT),
});

export const RestoreAgentMessageSchema = HistoryIdMessageSchema.extend({
  command: z.literal(HISTORY_VIEW_COMMANDS.RESTORE_AGENT),
});

export const DeleteAgentMessageSchema = HistoryIdMessageSchema.extend({
  command: z.literal(HISTORY_VIEW_COMMANDS.DELETE_AGENT),
});

export const ClearHistoryMessageSchema = commandOnly(
  HISTORY_VIEW_COMMANDS.CLEAR_HISTORY,
);

export const ExportChatMdMessageSchema = HistoryIdMessageSchema.extend({
  command: z.literal(HISTORY_VIEW_COMMANDS.EXPORT_CHAT_MD),
});

export const ExportChatTexMessageSchema = HistoryIdMessageSchema.extend({
  command: z.literal(HISTORY_VIEW_COMMANDS.EXPORT_CHAT_TEX),
});

export const ExportChatHtmlMessageSchema = HistoryIdMessageSchema.extend({
  command: z.literal(HISTORY_VIEW_COMMANDS.EXPORT_CHAT_HTML),
});

/**
 * Schema definitions for HistoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_HISTORY, HISTORY_CLEARED)
 * Inbound: Frontend → Backend (GET_HISTORY_DATA, RERUN_AGENT, etc.)
 */
import { z } from 'zod';

import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands';

import { AgentCategorySchema } from './agent';

// ============================================================
// Data schemas
// ============================================================

const AgentConfigSummarySchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  agentCategory: AgentCategorySchema.optional(),
  inputFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  mediaFile: z.string().nullish(),
  mediaFiles: z.array(z.string()).optional(),
  referenceFile: z.string().nullish(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFile: z.string().nullish(),
  auxiliaryFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
  toolConfig: z.record(z.string(), z.unknown()).nullish(),
});

export const HistoryItemSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  agentConfig: AgentConfigSummarySchema,
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

const GetHistoryDataMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA),
});

const RerunAgentMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.RERUN_AGENT),
  historyId: z.string().min(1),
});

const RestoreAgentMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.RESTORE_AGENT),
  historyId: z.string().min(1),
});

const DeleteAgentMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.DELETE_AGENT),
  historyId: z.string().min(1),
});

const ClearHistoryMessageSchema = z.object({
  command: z.literal(HISTORY_VIEW_COMMANDS.CLEAR_HISTORY),
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const HistoryViewInboundMessageSchema = z.discriminatedUnion('command', [
  GetHistoryDataMessageSchema,
  RerunAgentMessageSchema,
  RestoreAgentMessageSchema,
  DeleteAgentMessageSchema,
  ClearHistoryMessageSchema,
]);

export type HistoryViewInboundMessage = z.infer<
  typeof HistoryViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry and dispatcher
// ============================================================

export type HistoryViewInboundHandlerRegistry =
  HandlerRegistry<HistoryViewInboundMessage>;

export const dispatchHistoryViewInbound = createDispatcher(
  HistoryViewInboundMessageSchema,
);

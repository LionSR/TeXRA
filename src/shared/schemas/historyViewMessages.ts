/**
 * Schema definitions for HistoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_HISTORY, HISTORY_CLEARED)
 * Inbound: Frontend → Backend (GET_HISTORY_DATA, RERUN_AGENT, etc.)
 */
import { z } from 'zod';

import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands';

// ============================================================
// Data schemas
// ============================================================

const AgentConfigSummarySchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  agentCategory: z.enum(['workflow', 'toolUse']).optional(),
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
// Type-safe handler registry
// ============================================================

type TypedInboundHandler<T extends HistoryViewInboundMessage> = (
  data: T,
) => Promise<void> | void;

export type HistoryViewInboundHandlerRegistry = {
  [K in HistoryViewInboundMessage['command']]?: TypedInboundHandler<
    Extract<HistoryViewInboundMessage, { command: K }>
  >;
};

// ============================================================
// Dispatcher function
// ============================================================

export function dispatchHistoryViewInbound(
  raw: unknown,
  handlers: HistoryViewInboundHandlerRegistry,
  onError?: (error: unknown) => void,
): boolean {
  const result = HistoryViewInboundMessageSchema.safeParse(raw);
  if (!result.success) {
    onError?.(result.error);
    return false;
  }

  const message = result.data;
  const handler = handlers[message.command] as
    | TypedInboundHandler<typeof message>
    | undefined;

  if (handler) {
    const maybePromise = handler(message);
    if (maybePromise instanceof Promise) {
      maybePromise.catch((error) => onError?.(error));
    }
    return true;
  }

  return false;
}

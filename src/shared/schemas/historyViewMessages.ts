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
import { RUN_OUTCOME, type RunOutcome } from './stream';
import { ToolConfigSchema } from './toolConfig';

// ============================================================
// Data schemas
// ============================================================

/**
 * Status of a persisted run as shown in a history list.
 *
 * `unknown` is load-bearing: a run whose terminal write never landed (crash,
 * kill, or a build that predates the write) has no outcome to report, and
 * reporting `completed` for it would mask the crash.
 */
export const HISTORY_RUN_STATUS = {
  RESUMABLE: 'resumable',
  COMPLETED: RUN_OUTCOME.COMPLETED,
  CANCELLED: RUN_OUTCOME.CANCELLED,
  FAILED: RUN_OUTCOME.FAILED,
  UNKNOWN: 'unknown',
} as const;

export const HISTORY_RUN_STATUS_LABEL = {
  [HISTORY_RUN_STATUS.RESUMABLE]: 'Resumable',
  [HISTORY_RUN_STATUS.COMPLETED]: 'Completed',
  [HISTORY_RUN_STATUS.CANCELLED]: 'Cancelled',
  [HISTORY_RUN_STATUS.FAILED]: 'Failed',
  [HISTORY_RUN_STATUS.UNKNOWN]: 'Unknown',
} as const satisfies Record<
  (typeof HISTORY_RUN_STATUS)[keyof typeof HISTORY_RUN_STATUS],
  string
>;

const HistoryRunStatusSchema = z.enum(HISTORY_RUN_STATUS);
export type HistoryRunStatus = z.infer<typeof HistoryRunStatusSchema>;

/**
 * Project a storage resumability decision onto the history status vocabulary.
 * Resumability outranks the terminal outcome: what a user can continue is the
 * fact the list acts on.
 */
export function resolveHistoryRunStatus(decision: {
  readonly resumable: boolean;
  readonly outcome?: RunOutcome;
}): HistoryRunStatus {
  if (decision.resumable) return HISTORY_RUN_STATUS.RESUMABLE;
  return decision.outcome ?? HISTORY_RUN_STATUS.UNKNOWN;
}

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
  status: HistoryRunStatusSchema,
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

export const HistoryClearedMessageSchema = commandOnly(
  HISTORY_VIEW_COMMANDS.HISTORY_CLEARED,
);

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** Schema with `command` + the history ID of the item being operated on. */
function withHistoryId<T extends string>(command: T) {
  return z.object({
    command: z.literal(command),
    historyId: z.string().min(1),
  });
}

export const RerunAgentMessageSchema = withHistoryId(
  HISTORY_VIEW_COMMANDS.RERUN_AGENT,
);

export const RestoreAgentMessageSchema = withHistoryId(
  HISTORY_VIEW_COMMANDS.RESTORE_AGENT,
);

export const DeleteAgentMessageSchema = withHistoryId(
  HISTORY_VIEW_COMMANDS.DELETE_AGENT,
);

export const ClearHistoryMessageSchema = commandOnly(
  HISTORY_VIEW_COMMANDS.CLEAR_HISTORY,
);

export const ExportChatMdMessageSchema = withHistoryId(
  HISTORY_VIEW_COMMANDS.EXPORT_CHAT_MD,
);

export const ExportChatTexMessageSchema = withHistoryId(
  HISTORY_VIEW_COMMANDS.EXPORT_CHAT_TEX,
);

export const ExportChatHtmlMessageSchema = withHistoryId(
  HISTORY_VIEW_COMMANDS.EXPORT_CHAT_HTML,
);

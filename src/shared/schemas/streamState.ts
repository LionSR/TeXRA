import { z } from 'zod';

import {
  AGENT_CATEGORY,
  AgentCategorySchema,
  type AgentCategory,
} from './agent';
import { OutputFileInfoSchema } from './output';
import { InstructionUpdateSchema, StreamStatusSchema } from './stream';
import { TaskGroupSchema } from './taskGroup';
import { PlanSchema } from './plan';
import { TodoItemSchema } from './todo';
import { ContextStateSchema, TokenUsageStatsSchema } from './usage';

// Followup Mode

export const FOLLOWUP_MODE = {
  CHAT: 'chat',
  WORKFLOW: 'workflow',
  MERGE: 'merge',
} as const;

export const FollowupModeSchema = z.enum([
  FOLLOWUP_MODE.CHAT,
  FOLLOWUP_MODE.WORKFLOW,
  FOLLOWUP_MODE.MERGE,
]);

export type FollowupMode = z.infer<typeof FollowupModeSchema>;

// Active Child Info (shared shape for subagent and process badges)

export const ActiveChildInfoSchema = z.object({
  executionId: z.string(),
  agentName: z.string(),
  /** Stream tab ID for subagents (they have their own tab). Absent for processes. */
  childStreamId: z.string().optional(),
  /** Current execution status (e.g. "running", "waiting"). Defaults to "running". */
  status: z.string().optional(),
  /** Formatted elapsed time (e.g. "1m 23s"). */
  elapsed: z.string().nullable().optional(),
});

export type ActiveChildInfo = z.infer<typeof ActiveChildInfoSchema>;

// Conversation Progress (ephemeral counters updated during execution)

export const ConversationProgressSchema = z.object({
  /** Number of conversation turns (model invocations) completed. */
  conversationTurns: z.number().prefault(0),
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number().prefault(0),
});

export type ConversationProgress = z.infer<typeof ConversationProgressSchema>;

// Stream Metadata — the lightweight subset sent over postMessage in UPDATE_STREAMS.
// Contains only backend-owned fields that mergeBackendOwnedState() actually reads.

const BackendOwnedFieldsSchema = z.object({
  status: StreamStatusSchema.optional(),
  lastTimestamp: z.number().optional(),
  conversationProgress: ConversationProgressSchema.prefault({}),
  activeSubagents: z.array(ActiveChildInfoSchema).prefault([]),
  finishedSubagentCount: z.number().prefault(0),
  activeProcesses: z.array(ActiveChildInfoSchema).prefault([]),
  finishedProcessCount: z.number().prefault(0),
});

export const StreamMetadataSchema = BackendOwnedFieldsSchema.extend({
  kind: AgentCategorySchema,
});

export type StreamMetadata = z.infer<typeof StreamMetadataSchema>;

// Base Stream State

const BaseStreamStateSchema = BackendOwnedFieldsSchema.extend({
  // Frontend-owned fields — set by frontend handlers, preserved during backend merges.
  taskGroups: z.array(TaskGroupSchema).prefault([]),
  contextState: ContextStateSchema.optional(),
});

// Tool-Use UI State (frontend-only, preserved during backend updates)

export const ToolUseUIStateSchema = z.object({
  followUpText: z.string().prefault(''),
  polishedText: z.string().nullable().prefault(null),
  polishRevision: z.int().prefault(0),
  transcribedText: z.string().nullable().prefault(null),
  recording: z.boolean().prefault(false),
  shouldFocusFollowUp: z.boolean().prefault(false),
});

export type ToolUseUIState = z.infer<typeof ToolUseUIStateSchema>;

// Shared helper for run-keyed records

function RunScopedRecord<T extends z.ZodType>(valueSchema: T) {
  return z.record(z.string(), valueSchema).prefault({});
}

// Tool-Use Stream State

export const ToolUseStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AGENT_CATEGORY.TOOL_USE),
  // Frontend-owned fields updated by targeted progress-view messages
  todos: z.array(TodoItemSchema).prefault([]),
  /** Optional high-level summary for the todo list (e.g., plan overview). */
  todoSummary: z.string().nullable().prefault(null),
  /** @deprecated Kept for backward compatibility during migration. Use todos + todoSummary instead. */
  plan: PlanSchema.nullable().prefault(null),
  queuedFollowUps: z.array(z.string()).prefault([]),
  toolEditBypass: z.boolean().optional(),
  superYoloBypass: z.boolean().optional(),
  // Per-run usage for accumulation; sessionUsage is derived as their sum.
  runUsage: RunScopedRecord(TokenUsageStatsSchema),
  sessionUsage: TokenUsageStatsSchema.nullable().prefault(null),
  // Frontend-owned (nested under ui)
  ui: ToolUseUIStateSchema.prefault({}),
});

export type ToolUseStreamState = z.infer<typeof ToolUseStreamStateSchema>;

// Workflow UI State (frontend-only, preserved during backend updates)

export const WorkflowUIStateSchema = z.object({
  selectedRunId: z.string().nullable().prefault(null),
});

export type WorkflowUIState = z.infer<typeof WorkflowUIStateSchema>;

// Workflow Stream State

function RoundScopedRecord<T extends z.ZodType>(valueSchema: T) {
  return z
    .record(z.string(), z.record(z.string(), z.array(valueSchema)))
    .prefault({});
}

export const WorkflowStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AGENT_CATEGORY.WORKFLOW),
  // Frontend-owned fields updated by targeted progress-view messages
  runInstructions: RunScopedRecord(InstructionUpdateSchema),
  runUsage: RunScopedRecord(TokenUsageStatsSchema),
  runFiles: RoundScopedRecord(OutputFileInfoSchema),
  runMissingOutputs: RoundScopedRecord(z.string()),
  activeRunId: z.string().nullable().prefault(null),
  followupMode: FollowupModeSchema.prefault(FOLLOWUP_MODE.CHAT),
  // Frontend-owned (nested under ui)
  ui: WorkflowUIStateSchema.prefault({}),
});

export type WorkflowStreamState = z.infer<typeof WorkflowStreamStateSchema>;

// Discriminated Union

export const StreamStateSchema = z.discriminatedUnion('kind', [
  ToolUseStreamStateSchema,
  WorkflowStreamStateSchema,
]);

export type StreamState = z.infer<typeof StreamStateSchema>;

// Type Guards

export function isToolUseState(
  state: StreamState,
): state is ToolUseStreamState {
  return state.kind === AGENT_CATEGORY.TOOL_USE;
}

export function isWorkflowState(
  state: StreamState,
): state is WorkflowStreamState {
  return state.kind === AGENT_CATEGORY.WORKFLOW;
}

// Factory Functions

export function createToolUseStreamState(
  partial?: Partial<ToolUseStreamState>,
): ToolUseStreamState {
  return ToolUseStreamStateSchema.parse({
    kind: AGENT_CATEGORY.TOOL_USE,
    ...partial,
  });
}

export function createWorkflowStreamState(
  partial?: Partial<WorkflowStreamState>,
): WorkflowStreamState {
  return WorkflowStreamStateSchema.parse({
    kind: AGENT_CATEGORY.WORKFLOW,
    ...partial,
  });
}

export function createStreamState(
  agentCategory: AgentCategory,
  partial?: Partial<StreamState>,
): StreamState {
  if (agentCategory === AGENT_CATEGORY.TOOL_USE) {
    return createToolUseStreamState(partial as Partial<ToolUseStreamState>);
  }
  return createWorkflowStreamState(partial as Partial<WorkflowStreamState>);
}

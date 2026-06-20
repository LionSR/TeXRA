import { z } from 'zod';

import { GoalStatusSchema } from './goal';
import { AgentCategory, AgentCategorySchema } from './agent';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import { STREAM_STATUS, StreamStatusSchema } from './stream';
import { TaskGroupSchema } from './taskGroup';
import { PlanSchema } from './plan';
import { TodoItemSchema } from './todo';
import { ContextStateDataSchema } from './contextManagement';
import { TokenUsageStatsSchema } from './usage';

// Active Child Info (shared shape for subagent and process badges)

export const ActiveChildInfoSchema = z.object({
  executionId: z.string(),
  agentName: z.string(),
  /** Stream tab ID for subagents (they have their own tab). Absent for processes. */
  childStreamId: z.string().optional(),
  /** Current execution status (e.g. "running", "waiting"). Defaults to "running". */
  status: z.string().optional(),
  /** Epoch milliseconds when the child execution began. */
  startedAt: z.int().positive().optional(),
  /** Formatted elapsed time (e.g. "1m 23s"). */
  elapsed: z.string().nullable().optional(),
  /** Tool name that spawned this process (e.g. "bash", "codex"). Absent for subagents. */
  toolName: z.string().optional(),
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

export const DEFAULT_CONVERSATION_PROGRESS: ConversationProgress = {
  conversationTurns: 0,
  toolCallCount: 0,
};

export const DEFAULT_STREAM_METADATA_STATUS = STREAM_STATUS.READY;
export const DEFAULT_FINISHED_CHILD_COUNT = 0;

// Stream Metadata — the lightweight subset sent over postMessage in UPDATE_STREAMS.
// Contains only backend-owned fields that mergeBackendOwnedState() actually reads.

const BackendOwnedFieldsSchema = z.object({
  status: StreamStatusSchema.prefault(DEFAULT_STREAM_METADATA_STATUS),
  lastTimestamp: z.number().optional(),
  conversationProgress: ConversationProgressSchema.prefault(
    DEFAULT_CONVERSATION_PROGRESS,
  ),
  activeSubagents: z.array(ActiveChildInfoSchema).prefault([]),
  finishedSubagentCount: z.number().prefault(DEFAULT_FINISHED_CHILD_COUNT),
  activeProcesses: z.array(ActiveChildInfoSchema).prefault([]),
  finishedProcessCount: z.number().prefault(DEFAULT_FINISHED_CHILD_COUNT),
});

export const StreamMetadataSchema = BackendOwnedFieldsSchema.extend({
  kind: AgentCategorySchema,
});

export type StreamMetadata = z.infer<typeof StreamMetadataSchema>;

// Base Stream State

const BaseStreamStateSchema = BackendOwnedFieldsSchema.extend({
  // Frontend-owned fields — set by frontend handlers, preserved during backend merges.
  taskGroups: z.array(TaskGroupSchema).prefault([]),
  contextState: ContextStateDataSchema.optional(),
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
  kind: z.literal(AgentCategory.ToolUse),
  // Frontend-owned fields updated by targeted progress-view messages
  todos: z.array(TodoItemSchema).prefault([]),
  plan: PlanSchema.nullable().prefault(null),
  queuedFollowUps: z.array(z.string()).prefault([]),
  toolEditBypass: z.boolean().optional(),
  superYoloBypass: z.boolean().optional(),
  goalActive: z.boolean().optional(),
  goalStatus: GoalStatusSchema.optional(),
  goalObjective: z.string().optional(),
  // Per-run usage for accumulation; sessionUsage is derived as their sum.
  runUsage: RunScopedRecord(TokenUsageStatsSchema),
  sessionUsage: TokenUsageStatsSchema.nullable().prefault(null),
  // Frontend-owned (nested under ui)
  ui: ToolUseUIStateSchema.prefault({}),
});

export type ToolUseStreamState = z.infer<typeof ToolUseStreamStateSchema>;

// Workflow Stream State
// One run per tab — all run-scoped data is flat, not keyed by runId.

function RoundIndexedRecord<T extends z.ZodType>(valueSchema: T) {
  return z.record(z.string(), z.array(valueSchema)).prefault({});
}

export const WorkflowStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AgentCategory.Workflow),
  // Frontend-owned fields updated by targeted progress-view messages.
  // Per-run usage mirrors tool-use so resume correctly accumulates across
  // the original and resumed runs; sessionUsage is derived as their sum.
  runUsage: RunScopedRecord(TokenUsageStatsSchema),
  sessionUsage: TokenUsageStatsSchema.nullable().prefault(null),
  files: RoundIndexedRecord(OutputFileInfoSchema),
  missingOutputs: RoundIndexedRecord(z.string()),
  compileFailures: RoundIndexedRecord(CompileFailureSchema),
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
  return state.kind === AgentCategory.ToolUse;
}

export function isWorkflowState(
  state: StreamState,
): state is WorkflowStreamState {
  return state.kind === AgentCategory.Workflow;
}

// Factory Functions

export function createToolUseStreamState(
  partial?: Partial<ToolUseStreamState>,
): ToolUseStreamState {
  return ToolUseStreamStateSchema.parse({
    kind: AgentCategory.ToolUse,
    ...partial,
  });
}

export function createWorkflowStreamState(
  partial?: Partial<WorkflowStreamState>,
): WorkflowStreamState {
  return WorkflowStreamStateSchema.parse({
    kind: AgentCategory.Workflow,
    ...partial,
  });
}

export function createStreamState(
  agentCategory: AgentCategory,
  partial?: Partial<StreamState>,
): StreamState {
  if (agentCategory === AgentCategory.ToolUse) {
    return createToolUseStreamState(partial as Partial<ToolUseStreamState>);
  }
  return createWorkflowStreamState(partial as Partial<WorkflowStreamState>);
}

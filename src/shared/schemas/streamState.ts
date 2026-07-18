import { z } from 'zod';

import { GoalStatusSchema } from './goal';
import { AgentCategory, AgentCategorySchema } from './agent';
import { CompileFailureSchema, OutputFileInfoSchema } from './output';
import { roundIndexedRecord } from './roundIndexed';
import {
  STREAM_STATUS,
  StreamLifecycleStatusSchema,
  StreamSubstateSchema,
} from './stream';
import { TaskGroupSchema } from './taskGroup';
import { PlanSchema } from './plan';
import { TodoItemSchema } from './todo';
import { ContextStateDataSchema } from './contextManagement';
import { RunUsageMapSchema, TokenUsageStatsSchema } from './usage';

// Active Child Info — discriminated by `kind` rather than by which array the
// entry came from (`activeSubagents` vs `activeProcesses`) or by guessing from
// which optional field happens to be set. Only `childStreamId` is genuinely
// exclusive to one kind (only subagents own a stream tab); `toolName` can
// appear on either kind — e.g. a subagent launched via a specific CLI tool
// (`options.toolName` in `createChildStream`), or a background process running
// a named tool (`bash`, `codex`) — so it stays a shared, optional field.

const ActiveChildInfoBaseSchema = z.object({
  executionId: z.string(),
  agentName: z.string(),
  /** Current execution status (e.g. "running", "waiting"). Defaults to "running". */
  status: z.string().optional(),
  /** Epoch milliseconds when the child execution began. */
  startedAt: z.int().positive().optional(),
  /** Formatted elapsed time (e.g. "1m 23s"). */
  elapsed: z.string().nullish(),
  /** Tool that spawned this child (e.g. "bash", "codex"). Used for icon/label
   *  selection in the UI; may be set on either kind. */
  toolName: z.string().optional(),
});

/**
 * Persisted/replayed ActiveChildInfo entries predate the `kind` discriminant,
 * when subagent vs. process was inferred from array membership
 * (`activeSubagents` vs. `activeProcesses`) or from whether `childStreamId`
 * happened to be set. `childStreamId` was — and still is — exclusive to
 * subagents, so backfill `kind` from that same signal on read, matching the
 * legacy inference, instead of failing to parse.
 */
function fillLegacyActiveChildKind(raw: unknown): unknown {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { kind?: unknown }).kind !== undefined
  ) {
    return raw;
  }
  const data = raw as Record<string, unknown>;
  return {
    ...data,
    kind: typeof data.childStreamId === 'string' ? 'subagent' : 'process',
  };
}

export const ActiveChildInfoSchema = z.preprocess(
  fillLegacyActiveChildKind,
  z.discriminatedUnion('kind', [
    ActiveChildInfoBaseSchema.extend({
      kind: z.literal('subagent'),
      /** Stream tab ID — subagents own their own tab. */
      childStreamId: z.string(),
    }),
    ActiveChildInfoBaseSchema.extend({
      kind: z.literal('process'),
    }),
  ]),
);

export type ActiveChildInfo = z.infer<typeof ActiveChildInfoSchema>;
export type SubagentChildInfo = Extract<ActiveChildInfo, { kind: 'subagent' }>;

// Round Stage (ephemeral round label from typed stage.start metadata)

export const RoundStageSchema = z.object({
  /** Zero-based round/turn index. */
  index: z.int().nonnegative(),
  /** Planned total, when known. Workflow runs set this; tool-use turns may not. */
  total: z.int().positive().optional(),
});

export type RoundStage = z.infer<typeof RoundStageSchema>;

// Conversation Progress (tool-call counters updated during execution)

export const ConversationProgressSchema = z.object({
  /** Cumulative number of individual tool calls executed. */
  toolCallCount: z.number().prefault(0),
});

export type ConversationProgress = z.infer<typeof ConversationProgressSchema>;

export const DEFAULT_CONVERSATION_PROGRESS: ConversationProgress = {
  toolCallCount: 0,
};

export const DEFAULT_STREAM_METADATA_STATUS = STREAM_STATUS.READY;
export const DEFAULT_FINISHED_CHILD_COUNT = 0;

// Stream Metadata — the lightweight subset sent over postMessage in UPDATE_STREAMS.
// Contains only backend-owned fields that mergeBackendOwnedState() actually reads.

export const BackendOwnedFieldsSchema = z.object({
  status: StreamLifecycleStatusSchema.prefault(DEFAULT_STREAM_METADATA_STATUS),
  substate: StreamSubstateSchema.optional(),
  lastTimestamp: z.number().optional(),
  conversationProgress: ConversationProgressSchema.prefault(
    DEFAULT_CONVERSATION_PROGRESS,
  ),
  roundStage: RoundStageSchema.optional(),
  activeSubagents: z.array(ActiveChildInfoSchema).prefault([]),
  finishedSubagentCount: z.number().prefault(DEFAULT_FINISHED_CHILD_COUNT),
  activeProcesses: z.array(ActiveChildInfoSchema).prefault([]),
  finishedProcessCount: z.number().prefault(DEFAULT_FINISHED_CHILD_COUNT),
});

const BackendOwnedMetadataFieldsSchema = BackendOwnedFieldsSchema.extend({
  roundStage: RoundStageSchema.nullable().optional(),
});

export const StreamMetadataSchema = BackendOwnedMetadataFieldsSchema.extend({
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

const ToolUseUIStateSchema = z.object({
  followUpText: z.string().prefault(''),
  polishedText: z.string().nullable().prefault(null),
  polishRevision: z.int().prefault(0),
  transcribedText: z.string().nullable().prefault(null),
  recording: z.boolean().prefault(false),
  shouldFocusFollowUp: z.boolean().prefault(false),
});

// Tool-Use Stream State

const ToolUseStreamStateSchema = BaseStreamStateSchema.extend({
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
  runUsage: RunUsageMapSchema.prefault({}),
  sessionUsage: TokenUsageStatsSchema.nullable().prefault(null),
  // Frontend-owned (nested under ui)
  ui: ToolUseUIStateSchema.prefault({}),
});

export type ToolUseStreamState = z.infer<typeof ToolUseStreamStateSchema>;

// Workflow Stream State
// One run per tab — all run-scoped data is flat, not keyed by runId.

const WorkflowStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AgentCategory.Workflow),
  // Frontend-owned fields updated by targeted progress-view messages.
  // Per-run usage mirrors tool-use so resume correctly accumulates across
  // the original and resumed runs; sessionUsage is derived as their sum.
  runUsage: RunUsageMapSchema.prefault({}),
  sessionUsage: TokenUsageStatsSchema.nullable().prefault(null),
  files: roundIndexedRecord(OutputFileInfoSchema).prefault({}),
  missingOutputs: roundIndexedRecord(z.string()).prefault({}),
  compileFailures: roundIndexedRecord(CompileFailureSchema).prefault({}),
});

export type WorkflowStreamState = z.infer<typeof WorkflowStreamStateSchema>;

// Discriminated Union

const StreamStateSchema = z.discriminatedUnion('kind', [
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

function createToolUseStreamState(
  partial?: Partial<ToolUseStreamState>,
): ToolUseStreamState {
  return ToolUseStreamStateSchema.parse({
    kind: AgentCategory.ToolUse,
    ...partial,
  });
}

function createWorkflowStreamState(
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

/**
 * Zod schemas for frontend stream state.
 * Discriminated union based on agent category for type-safe state management.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import { AGENT_CATEGORY, type AgentCategory } from './agent';
import { LogMessageDataSchema } from './log';
import { OutputFileInfoSchema } from './output';
import { ContextStateSchema } from './progressViewMessages';
import {
  InstructionUpdateSchema,
  StreamStatusSchema,
  StreamTabInfoSchema,
} from './stream';
import { TaskGroupSchema } from './taskGroup';
import { TodoItemSchema } from './todo';
import { TokenUsageStatsSchema } from './usage';

// =============================================================================
// Followup Mode (frontend-only concept)
// =============================================================================

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

// =============================================================================
// Base Stream State (shared fields)
// =============================================================================

const BaseStreamStateSchema = z.object({
  /** Stream metadata from backend (set on first UPDATE_STREAMS) */
  info: StreamTabInfoSchema.optional(),
  /** Stream status (running, stopped, etc.) */
  status: StreamStatusSchema.optional(),
  /** Log messages for this stream */
  logs: z.array(LogMessageDataSchema).prefault([]),
  /** Task groups (runs and their subtasks) */
  taskGroups: z.array(TaskGroupSchema).prefault([]),
  /** Context window state for display */
  contextState: ContextStateSchema.optional(),
});

// =============================================================================
// Tool-Use Stream State
// =============================================================================

export const ToolUseStreamStateSchema = BaseStreamStateSchema.extend({
  /** Discriminator for tool-use streams */
  kind: z.literal(AGENT_CATEGORY.TOOL_USE),
  /** Todo items for task tracking */
  todos: z.array(TodoItemSchema).prefault([]),
  /** Queued follow-up messages */
  queuedFollowUps: z.array(z.string()).prefault([]),
  /** Text in the follow-up input field */
  followUpText: z.string().prefault(''),
  /** Whether tool edit approval is bypassed (YOLO mode) */
  toolEditBypass: z.boolean().optional(),
});
export type ToolUseStreamState = z.infer<typeof ToolUseStreamStateSchema>;

// =============================================================================
// Workflow Stream State
// =============================================================================

/** Run-scoped record: Record<runId, T> */
const RunScopedRecord = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.record(z.string(), valueSchema).prefault({});

/** Round-scoped record: Record<runId, Record<round, T[]>> */
const RoundScopedRecord = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.record(z.string(), z.record(z.string(), z.array(valueSchema))).prefault({});

export const WorkflowStreamStateSchema = BaseStreamStateSchema.extend({
  /** Discriminator for workflow streams */
  kind: z.literal(AGENT_CATEGORY.WORKFLOW),
  /** Instructions per run */
  runInstructions: RunScopedRecord(InstructionUpdateSchema),
  /** Token usage per run */
  runUsage: RunScopedRecord(TokenUsageStatsSchema),
  /** Output files per run per round */
  runFiles: RoundScopedRecord(OutputFileInfoSchema),
  /** Missing outputs per run per round */
  runMissingOutputs: RoundScopedRecord(z.string()),
  /** Active run ID from backend */
  activeRunId: z.string().nullable().prefault(null),
  /** User-selected run ID */
  selectedRunId: z.string().nullable().prefault(null),
  /** Current followup mode */
  followupMode: FollowupModeSchema.prefault(FOLLOWUP_MODE.CHAT),
});
export type WorkflowStreamState = z.infer<typeof WorkflowStreamStateSchema>;

// =============================================================================
// Discriminated Union
// =============================================================================

export const StreamStateSchema = z.discriminatedUnion('kind', [
  ToolUseStreamStateSchema,
  WorkflowStreamStateSchema,
]);
export type StreamState = z.infer<typeof StreamStateSchema>;

// =============================================================================
// Type Guards
// =============================================================================

/** Type guard for tool-use stream state */
export function isToolUseState(
  state: StreamState,
): state is ToolUseStreamState {
  return state.kind === AGENT_CATEGORY.TOOL_USE;
}

/** Type guard for workflow stream state */
export function isWorkflowState(
  state: StreamState,
): state is WorkflowStreamState {
  return state.kind === AGENT_CATEGORY.WORKFLOW;
}

// =============================================================================
// Factory Functions
// =============================================================================

/** Create empty tool-use stream state with defaults */
export function createToolUseStreamState(
  partial?: Partial<ToolUseStreamState>,
): ToolUseStreamState {
  return ToolUseStreamStateSchema.parse({
    kind: AGENT_CATEGORY.TOOL_USE,
    ...partial,
  });
}

/** Create empty workflow stream state with defaults */
export function createWorkflowStreamState(
  partial?: Partial<WorkflowStreamState>,
): WorkflowStreamState {
  return WorkflowStreamStateSchema.parse({
    kind: AGENT_CATEGORY.WORKFLOW,
    ...partial,
  });
}

/** Create stream state based on agent category */
export function createStreamState(
  agentCategory: AgentCategory,
  partial?: Partial<StreamState>,
): StreamState {
  return agentCategory === AGENT_CATEGORY.TOOL_USE
    ? createToolUseStreamState(partial as Partial<ToolUseStreamState>)
    : createWorkflowStreamState(partial as Partial<WorkflowStreamState>);
}

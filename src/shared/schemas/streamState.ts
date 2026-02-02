import { z } from 'zod';

import { AGENT_CATEGORY, type AgentCategory } from './agent';
import { LogMessageDataSchema } from './log';
import { OutputFileInfoSchema } from './output';
import {
  InstructionUpdateSchema,
  StreamStatusSchema,
  StreamTabInfoSchema,
} from './stream';
import { TaskGroupSchema } from './taskGroup';
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

// Base Stream State

const BaseStreamStateSchema = z.object({
  info: StreamTabInfoSchema.optional(),
  status: StreamStatusSchema.optional(),
  logs: z.array(LogMessageDataSchema).prefault([]),
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

// Tool-Use Stream State

export const ToolUseStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AGENT_CATEGORY.TOOL_USE),
  // Backend-owned fields
  todos: z.array(TodoItemSchema).prefault([]),
  queuedFollowUps: z.array(z.string()).prefault([]),
  toolEditBypass: z.boolean().optional(),
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

const RunScopedRecord = <T extends z.ZodType>(valueSchema: T) =>
  z.record(z.string(), valueSchema).prefault({});

const RoundScopedRecord = <T extends z.ZodType>(valueSchema: T) =>
  z.record(z.string(), z.record(z.string(), z.array(valueSchema))).prefault({});

export const WorkflowStreamStateSchema = BaseStreamStateSchema.extend({
  kind: z.literal(AGENT_CATEGORY.WORKFLOW),
  // Backend-owned fields
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

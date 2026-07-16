// Shared imports
import {
  AgentCategory,
  type ActiveChildInfo,
  type CompileFailure,
  type ConversationProgress,
  type GoalStatus,
  type OutputFileInfo,
  type Plan,
  type RoundIndexed,
  type RoundStage,
  type StreamTabId,
  type SyncStreamContentPayload,
  type TokenUsageStats,
  type TodoItem,
  type ToolUseStreamContentPayload,
  type WorkflowStreamContentPayload,
} from '../schemas';

interface ClearStreamContentSync {
  action: 'clear';
}

interface ActiveStreamContentSync {
  conversationProgress: ConversationProgress;
  roundStage: RoundStage | null;
  badges: {
    activeSubagents: ActiveChildInfo[];
    finishedSubagentCount: number;
    activeProcesses: ActiveChildInfo[];
    finishedProcessCount: number;
  };
  parentStreamId: StreamTabId | null;
}

interface StreamContentSyncBase {
  stream: StreamTabId;
  runUsage: Record<string, TokenUsageStats>;
  activeState?: ActiveStreamContentSync;
}

interface WorkflowStreamContentSync extends StreamContentSyncBase {
  kind: typeof AgentCategory.Workflow;
  files: RoundIndexed<OutputFileInfo>;
  missingOutputs: RoundIndexed<string>;
  compileFailures: RoundIndexed<CompileFailure>;
}

interface ToolUseStreamContentSync extends StreamContentSyncBase {
  kind: typeof AgentCategory.ToolUse;
  todos: TodoItem[];
  plan: Plan | null;
  queuedFollowUps: string[];
  toolEditBypass: boolean;
  superYoloBypass: boolean;
  goal:
    { active: false } | { active: true; status: GoalStatus; objective: string };
}

export type StreamContentSyncSnapshot =
  ClearStreamContentSync | WorkflowStreamContentSync | ToolUseStreamContentSync;

/** Projects canonical state into one of the three valid transport variants. */
export function buildStreamContentSync(
  snapshot: ClearStreamContentSync,
): Extract<SyncStreamContentPayload, { action: 'clear' }>;
export function buildStreamContentSync(
  snapshot: WorkflowStreamContentSync,
): WorkflowStreamContentPayload;
export function buildStreamContentSync(
  snapshot: ToolUseStreamContentSync,
): ToolUseStreamContentPayload;
export function buildStreamContentSync(
  snapshot: StreamContentSyncSnapshot,
): SyncStreamContentPayload {
  if ('action' in snapshot) return snapshot;

  const { stream, runUsage, activeState } = snapshot;
  const shared = {
    action: 'render' as const,
    stream,
    runUsage,
    ...(activeState ? { activeState } : {}),
  };

  if (snapshot.kind === AgentCategory.Workflow) {
    return {
      ...shared,
      kind: snapshot.kind,
      outputs: {
        files: snapshot.files,
        missing: snapshot.missingOutputs,
        compileFailures: snapshot.compileFailures,
      },
    };
  }

  return {
    ...shared,
    kind: snapshot.kind,
    workPlan: {
      todos: snapshot.todos,
      plan: snapshot.plan,
      queuedFollowUps: snapshot.queuedFollowUps,
    },
    controls: {
      toolEditBypass: snapshot.toolEditBypass,
      superYoloBypass: snapshot.superYoloBypass,
      goal: snapshot.goal,
    },
  };
}

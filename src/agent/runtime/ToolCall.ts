/** Capabilities scoped to one tool invocation, supplied by its host boundary. */
import { Context } from 'effect';

import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import type { AgentTrace } from '@agent/trace';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { AgentRunShape } from './run/AgentRun';

export interface ToolCallShape {
  /** The roots of the workspace the call works on: the run's session roots. */
  readonly roots: WorkspaceRoots;
  readonly toolCallId?: string;
  readonly delegationAgentScope?: AgentRunShape['delegationAgentScope'];
  readonly model?: string;
  readonly workingDirectory?: string;
  readonly stopAfterCycle?: boolean;
  readonly onApprovalPolicyDenial?: () => void;
  readonly tracker: FileInteractionState;
  readonly trace?: AgentTrace;
  readonly userInstruction?: string;
  readonly workPlanState?: WorkPlanState;
  readonly hooks?: {
    /** What the tool prints while it runs, for its card's transient output. */
    readonly onToolOutput?: (chunk: string) => void;
    readonly recordSubagentCost?: (costUsd: number) => void;
  };
  /** Absent for a standalone host invocation outside an agent run. */
  readonly run:
    Pick<AgentRunShape, 'session' | 'runId' | 'toolPolicy'> | undefined;
}

export class ToolCall extends Context.Service<ToolCall, ToolCallShape>()(
  '@texra/agent/ToolCall',
) {}

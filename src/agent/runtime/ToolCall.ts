/** Capabilities scoped to one tool invocation, supplied by its host boundary. */
import { Context } from 'effect';

import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { AgentRunShape } from './run/AgentRun';

export interface ToolCallShape {
  /** The roots of the workspace the call works on: the run's session roots. */
  readonly roots: WorkspaceRoots;
  readonly toolCallId?: string;
  readonly workingDirectory?: string;
  /** The run's file-interaction record; absent outside an agent run. */
  readonly tracker?: FileInteractionState;
  readonly userInstruction?: string;
  readonly workPlanState?: WorkPlanState;
  readonly hooks?: {
    /** What the tool prints while it runs, for its card's transient output. */
    readonly onToolOutput?: (chunk: string) => void;
    readonly recordSubagentCost?: (costUsd: number) => void;
  };
  /**
   * Absent for a standalone host invocation outside an agent run. What the run
   * already answers for (its model, its delegation scope, its composition,
   * its approval-denial observer, its trace, its tool policy, its scope) is read from here rather
   * than copied onto the call. A tool that starts something the run should
   * stop at its end registers that stop on the run's scope.
   */
  readonly run:
    | Pick<
        AgentRunShape,
        | 'session'
        | 'runId'
        | 'toolPolicy'
        | 'config'
        | 'logger'
        | 'delegationAgentScope'
        | 'composition'
        | 'onApprovalPolicyDenial'
        | 'scope'
      >
    | undefined;
}

export class ToolCall extends Context.Service<ToolCall, ToolCallShape>()(
  '@texra/agent/ToolCall',
) {}

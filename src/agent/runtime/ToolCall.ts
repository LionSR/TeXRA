/** Capabilities scoped to one tool invocation, supplied by its host boundary. */
import { Context } from 'effect';

import type {
  FileInteractionState,
  WorkPlanState,
} from '@agent/core/state/AgentWorkspaceState';
import type { AgentTrace } from '@agent/trace';
import type { ConfigProvider } from '@platform/interfaces';
import type { RunScope } from './RunScope';
import type { AgentRunShape } from './run/AgentRun';

export interface ToolCallShape {
  readonly config: ConfigProvider;
  readonly toolCallId?: string;
  readonly delegationAgentScope?: RunScope['delegationAgentScope'];
  readonly model?: string;
  readonly workingDirectory?: string;
  readonly stopAfterCycle?: boolean;
  readonly onApprovalPolicyDenial?: () => void;
  readonly tracker: FileInteractionState;
  readonly trace?: AgentTrace;
  readonly userInstruction?: string;
  readonly workPlanState?: WorkPlanState;
  readonly hooks?: {
    readonly onRunReady?: () => void;
    readonly onToolOutput?: (chunk: string) => void;
    readonly recordSubagentCost?: (costUsd: number) => void;
  };
  /** Absent for a standalone host invocation outside an agent run. */
  readonly run:
    Pick<AgentRunShape, 'session' | 'runId' | 'toolPolicy'> | undefined;
  /** Enter the host's workspace frame only while calling its filesystem or legacy host API. */
  readonly inScope: <A>(operation: () => A) => A;
}

export class ToolCall extends Context.Service<ToolCall, ToolCallShape>()(
  '@texra/agent/ToolCall',
) {}

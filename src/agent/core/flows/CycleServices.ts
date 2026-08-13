/** Service interfaces for cycle flows. */

import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/state/AgentState';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import type { FinalTool } from '@agent/types/ModelHandlerContracts';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';

/**
 * Shared services for the cycle/round flows: the run-scoped file service and
 * state both inner primitives operate on. The live provider client comes from
 * the `modelCell` every flow already carries through `BaseFlowContextInit`.
 */
interface CycleRunServices<C = unknown> extends BaseFlowContextInit<C> {
  readonly fileService: TaskRunFileService;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  readonly toolRegistry: IToolRegistry;
}

/** Services for response cycle flow nodes. */
export interface ResponseCycleServices<
  C = unknown,
> extends CycleRunServices<C> {
  round: ConversationRoundStateSnapshot;
}

/**
 * Services for tool-use round flow nodes.
 *
 * A "round" is one LLM invocation + tool dispatch loop (the inner primitive).
 * The outer session step (ToolUseCycleNode) bridges ToolUseServices into this
 * interface by adding `run` and `workspace` before running the round.
 */
export interface ToolUseRoundServices<C = unknown> extends CycleRunServices<C> {
  /** Terminal tool available for the optional provider-native final turn. */
  readonly finalTool?: FinalTool;
  /** Session for injecting queued user messages after tool dispatch. */
  readonly session?: IToolUseSession;
  /** Callback when a queued follow-up is consumed (clears UI display). */
  readonly onFollowUpConsumed?: () => void;
}

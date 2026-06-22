/** Service interfaces for cycle flows. */

import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/execution/AgentState';
import type { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import type { TaskRunFileService } from '@utils/files';

/**
 * The live model-client contract every cycle/round flow shares because each
 * runs a `ModelInvocationNode`.
 *
 * - `client` is the provider SDK client for the run's active model.
 * - `refreshClient` re-fetches it after a mid-run model switch so the retry
 *   path picks up the new handler.
 *
 * Declared here (instead of being supplied implicitly through an erased
 * `setServices` call) so the cycle/round factories can type-check the outer
 * node that bridges these fields in before running the inner flow.
 */
export interface ModelClientServices<C = unknown> {
  readonly client: C;
  readonly refreshClient?: () => Promise<void>;
}

export interface TextConnectionService {
  /**
   * Determines the best textual connector between two strings in a LaTeX
   * document context (empty string, space, or newline).
   */
  readonly bestConnectionMethod: (
    str1: string,
    str2: string,
  ) => Promise<{ connector: string; choice: string }>;
}

/** Services for response cycle flow nodes. */
export interface ResponseCycleServices<C = unknown>
  extends BaseFlowContextInit<C>,
    ModelClientServices<C>,
    TextConnectionService {
  readonly fileService: TaskRunFileService;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

/**
 * Services for tool-use round flow nodes.
 *
 * A "round" is one LLM invocation + tool dispatch loop (the inner primitive).
 * The outer session step (ToolUseCycleNode) bridges ToolUseServices into this
 * interface by adding `run`, `workspace`, and the {@link ModelClientServices}
 * fields before running the round.
 */
export interface ToolUseRoundServices<C = unknown>
  extends BaseFlowContextInit<C>, ModelClientServices<C> {
  readonly fileService: TaskRunFileService;
  readonly toolRegistry: IToolRegistry;
  /** Session for injecting queued user messages after tool dispatch. */
  readonly session?: IToolUseSession;
  /** Callback when a queued follow-up is consumed (clears UI display). */
  readonly onFollowUpConsumed?: () => void;
  readonly run: AgentRunStateSnapshot;
  readonly workspace: AgentWorkspaceState;
}

export type CycleParams = Record<string, unknown>;

/**
 * Service interfaces and option types for cycle flows.
 *
 * Services are injected via PocketFlow's native service injection:
 * - `this.services` - immutable dependencies (logger, modelHandler, state slices)
 * - `shared` - mutable runtime state only
 */

import type {
  AgentRunState,
  ConversationRoundState,
} from '@agent/core/AgentState';
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { IToolUseSession } from '@agent/implementations/flows/tooluse/ToolUseSessionLifecycle';
import type { TaskRunFileService } from '@utils/files';

// ============================================================================
// CYCLE STATE SLICES
// ============================================================================

/** Callback invoked when a round/cycle completes for usage tracking. */
export type RoundFinalizedCallback = (
  run: AgentRunState,
) => void | Promise<void>;

/** Base state slices common to all cycle flows. */
export interface BaseCycleStateSlices {
  readonly run: AgentRunState;
  readonly workspace: AgentWorkspaceState;
  readonly onRoundFinalized?: RoundFinalizedCallback;
}

/** State slices for response cycle flows (includes round for workflow agents). */
export interface CycleStateSlices extends BaseCycleStateSlices {
  round: ConversationRoundState;
}

// ============================================================================
// CYCLE OPTIONS
// ============================================================================

/** Options for response cycle execution (workflow flows). */
export interface ResponseCycleOptions<
  C = unknown,
> extends AgentCycleBaseOptions<C> {
  config: AgentConfig;
  fileService: TaskRunFileService;
}

/** Options for tool-use cycle execution (interactive flows). */
export interface ToolUseCycleOptions<
  C = unknown,
> extends AgentCycleBaseOptions<C> {
  toolRegistry: IToolRegistry;
  modelName?: string;
  agentName?: string;
  /**
   * Session for follow-up queue access.
   * When provided, allows injecting queued user messages after tool dispatch
   * so the model can continue without ending the turn.
   */
  session?: IToolUseSession;
  /**
   * Callback invoked when a queued follow-up message is consumed.
   * Used to update the UI (clear the queued message display).
   */
  onFollowUpConsumed?: () => void;
}

// ============================================================================
// SERVICE CONTAINERS
// ============================================================================

/** Services for response cycle flows. Options flattened directly into services. */
export type ResponseCycleServices<C = unknown> = CycleStateSlices &
  Readonly<ResponseCycleOptions<C>>;

/** Services for tool-use cycle flows. Options flattened directly into services. */
export type ToolUseCycleServices<C = unknown> = BaseCycleStateSlices &
  Readonly<ToolUseCycleOptions<C>>;

/**
 * Params type for response cycle nodes.
 * Services are injected via `this.services`, not via params.
 */
export type ResponseCycleParams<C = unknown> = Record<string, unknown>;

/**
 * Params type for tool-use cycle nodes.
 * Services are injected via `this.services`, not via params.
 */
export type ToolUseCycleParams<C = unknown> = Record<string, unknown>;

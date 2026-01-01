/**
 * Service interfaces and option types for cycle flows.
 *
 * This module defines:
 * 1. Cycle option interfaces (ResponseCycleOptions, ToolUseCycleOptions)
 * 2. Service containers with state slices passed directly (no store wrapper)
 *
 * ## Architecture
 *
 * Services are injected via PocketFlow's `_params` mechanism:
 * - `_params.services` - immutable dependencies (logger, modelHandler, state slices)
 * - `shared` - mutable runtime state only
 *
 * State slices are passed directly for clarity:
 * - `services.round` - current round statistics and state
 * - `services.run` - accumulated run statistics
 * - `services.workspace` - workspace assembly and media
 *
 * ## Usage
 *
 * ```typescript
 * class MyNode extends BaseNode<CycleState, CycleParams<C>> {
 *   async exec(state: CycleState) {
 *     // Access state slices directly
 *     const { round, workspace, modelHandler } = this.services;
 *     // Access mutable state from shared
 *     const { messages } = state;
 *   }
 * }
 * ```
 */

import type {
  AgentRunState,
  ConversationRoundState,
} from '@agent/core/AgentState';
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { TaskRunFileService } from '@utils/files';

// ============================================================================
// CYCLE STATE SLICES
// ============================================================================

/**
 * Context passed to round finalization callback.
 * Contains all state slices for statistics recording.
 */
export interface RoundFinalizedContext {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
}

/**
 * Callback invoked when a round completes.
 * Used for usage tracking and statistics recording.
 */
export type RoundFinalizedCallback = (
  context: RoundFinalizedContext,
) => void | Promise<void>;

/**
 * State slices passed directly to cycle flows.
 * Replaces the AgentSharedStore wrapper for cleaner access.
 *
 * Names match the original store accessors (store.round, store.run, store.workspace)
 * for easy migration.
 */
export interface CycleStateSlices {
  /** Current round state for statistics (mutable for tool-use multi-round) */
  round: ConversationRoundState;

  /** Accumulated run state */
  readonly run: AgentRunState;

  /** Workspace state for assembly and media */
  readonly workspace: AgentWorkspaceState;

  /**
   * Callback invoked when round completes.
   * Called by finalize nodes for usage tracking.
   */
  readonly onRoundFinalized?: RoundFinalizedCallback;
}

// ============================================================================
// CYCLE OPTIONS (single source of truth)
// ============================================================================

/**
 * Options for response cycle execution.
 * Used by workflow flows for turn-based generation.
 */
export interface ResponseCycleOptions<
  C = unknown,
> extends AgentCycleBaseOptions<C> {
  agentConfig: AgentConfig;
  fileService: TaskRunFileService;
}

/**
 * Options for tool-use cycle execution.
 * Used by interactive flows for session-based execution.
 *
 * Note: Workspace state is passed via CycleStateSlices.workspace,
 * not duplicated here.
 */
export interface ToolUseCycleOptions<
  C = unknown,
> extends AgentCycleBaseOptions<C> {
  toolRegistry: IToolRegistry;
  modelName?: string;
  agentName?: string;
}

// ============================================================================
// SERVICE CONTAINERS (state slices + options merged directly)
// ============================================================================

/**
 * Base services shared by all cycle flows.
 * Contains state slices passed directly (no store wrapper).
 */
export type BaseCycleServices = CycleStateSlices;

/**
 * Services for response cycle flows.
 *
 * Options are flattened directly into services (no nested `options` wrapper).
 * Access via: `services.logger`, `services.round`, etc.
 */
export type ResponseCycleServices<C = unknown> = BaseCycleServices &
  Readonly<ResponseCycleOptions<C>>;

/**
 * Services for tool-use cycle flows.
 *
 * Options are flattened directly into services (no nested `options` wrapper).
 * Access via: `services.logger`, `services.round`, etc.
 */
export type ToolUseCycleServices<C = unknown> = BaseCycleServices &
  Readonly<ToolUseCycleOptions<C>>;

/**
 * Generic params type for cycle nodes.
 * Used with BaseNode's `_params` mechanism.
 *
 * Note: Index signature required to satisfy NonIterableObject constraint.
 *
 * @template TServices - The specific services type for this cycle
 */
export interface CycleParams<TServices extends BaseCycleServices> {
  [key: string]: unknown;
  services: TServices;
}

/** Params type for response cycle nodes. */
export type ResponseCycleParams<C = unknown> = CycleParams<
  ResponseCycleServices<C>
>;

/** Params type for tool-use cycle nodes. */
export type ToolUseCycleParams<C = unknown> = CycleParams<
  ToolUseCycleServices<C>
>;

// ============================================================================
// ROUND FINALIZATION (single source of truth)
// ============================================================================

/**
 * Finalize a round by recording statistics and invoking callback.
 *
 * This is the SINGLE SOURCE OF TRUTH for round finalization logic.
 * Both ResponseCycleFlow and ToolUseCycleFlow should use this helper
 * instead of duplicating the logic.
 *
 * @param slices - The cycle state slices containing round, run, workspace
 * @returns Promise that resolves when finalization is complete
 */
export async function finalizeRound(slices: CycleStateSlices): Promise<void> {
  const { round, run, workspace, onRoundFinalized } = slices;

  // Record round statistics in run state
  run.recordRound(round);

  // Invoke usage tracking callback if provided
  if (onRoundFinalized) {
    await onRoundFinalized({ round, run, workspace });
  }
}

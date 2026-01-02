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
 * - `services.run` - accumulated run statistics
 * - `services.workspace` - workspace assembly and media
 * - `services.round` - (reflection flows only) current round state
 *
 * ## Usage
 *
 * ```typescript
 * class MyNode extends BaseNode<CycleState, CycleParams<C>> {
 *   async exec(state: CycleState) {
 *     const { run, workspace, modelHandler } = this.services;
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
 * Callback invoked when a round/cycle completes.
 * Used for usage tracking - only needs run state since that's all consumers use.
 */
export type RoundFinalizedCallback = (
  run: AgentRunState,
) => void | Promise<void>;

/**
 * Base state slices common to all cycle flows.
 * Contains run state, workspace state, and optional callback.
 *
 * Extended by CycleStateSlices (with round) for reflection flows.
 */
export interface BaseCycleStateSlices {
  /** Accumulated run state */
  readonly run: AgentRunState;

  /** Workspace state for assembly and media */
  readonly workspace: AgentWorkspaceState;

  /**
   * Callback invoked when round/cycle completes.
   * Called by finalize nodes for usage tracking.
   */
  readonly onRoundFinalized?: RoundFinalizedCallback;
}

/**
 * State slices passed directly to response cycle flows.
 * Extends base with round object for round-based agents.
 *
 * Names match the original store accessors (store.round, store.run, store.workspace)
 * for easy migration.
 */
export interface CycleStateSlices extends BaseCycleStateSlices {
  /** Current round state for statistics (mutable for multi-round) */
  round: ConversationRoundState;
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
 * Services for response cycle flows.
 *
 * Options are flattened directly into services (no nested `options` wrapper).
 * Access via: `services.logger`, `services.round`, etc.
 */
export type ResponseCycleServices<C = unknown> = CycleStateSlices &
  Readonly<ResponseCycleOptions<C>>;

/**
 * Services for tool-use cycle flows.
 *
 * Options are flattened directly into services (no nested `options` wrapper).
 * Access via: `services.logger`, `services.run`, `services.workspace`, etc.
 *
 * Note: Tool-use cycles track metrics in flow state (cycleIndex, cycleResponseTimeMs)
 * instead of a round object, so this uses BaseCycleStateSlices (without round).
 */
export type ToolUseCycleServices<C = unknown> = BaseCycleStateSlices &
  Readonly<ToolUseCycleOptions<C>>;

/**
 * Generic params type for cycle nodes.
 * Used with BaseNode's `_params` mechanism.
 *
 * Note: Index signature required to satisfy NonIterableObject constraint.
 *
 * @template TServices - The specific services type for this cycle
 */
export interface CycleParams<TServices extends BaseCycleStateSlices> {
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
 * ResponseCycleFlow uses this helper (reflection agents have real rounds).
 *
 * @param slices - The cycle state slices containing round, run
 * @returns Promise that resolves when finalization is complete
 */
export async function finalizeRound(slices: CycleStateSlices): Promise<void> {
  const { round, run, onRoundFinalized } = slices;

  // Record round statistics in run state
  run.recordRound(round);

  // Invoke usage tracking callback if provided
  if (onRoundFinalized) {
    await onRoundFinalized(run);
  }
}

/**
 * Input for tool-use cycle finalization.
 * Takes values directly instead of reading from ConversationRoundState.
 */
export interface ToolUseCycleFinalizeInput {
  cycleIndex: number;
  responseTimeMs: number;
  normalizedUsage:
    | import('@agent/types/NormalizedUsage').NormalizedUsage
    | null;
  run: BaseCycleStateSlices['run'];
  onRoundFinalized?: RoundFinalizedCallback;
}

/**
 * Finalize a tool-use cycle by recording statistics directly.
 *
 * Unlike finalizeRound(), this takes values directly instead of reading
 * from a ConversationRoundState. This eliminates the need for tool-use
 * agents to maintain a round object that gets reset after each cycle.
 *
 * @param input - Direct values for cycle statistics
 */
export async function finalizeToolUseCycle(
  input: ToolUseCycleFinalizeInput,
): Promise<void> {
  const { cycleIndex, responseTimeMs, normalizedUsage, run } = input;

  // Record directly to run state (bypass round object)
  if (normalizedUsage) {
    run.usageAccumulator.recordNormalizedUsage(cycleIndex, normalizedUsage);
  }
  run.addResponseTime(responseTimeMs);

  // Invoke usage tracking callback if provided
  if (input.onRoundFinalized) {
    await input.onRoundFinalized(run);
  }
}

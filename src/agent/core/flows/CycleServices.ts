/**
 * Service interfaces and option types for cycle flows.
 *
 * This module defines:
 * 1. Cycle option interfaces (ResponseCycleOptions, ToolUseCycleOptions)
 * 2. Service container pattern for separating immutable dependencies from mutable state
 *
 * ## Architecture
 *
 * Services are injected via PocketFlow's `_params` mechanism:
 * - `_params.services` - immutable dependencies (logger, modelHandler, store)
 * - `shared` - mutable runtime state only
 *
 * This achieves:
 * 1. **Separation of concerns**: Dependencies vs data clearly separated
 * 2. **Single source of truth**: Services defined once, accessed consistently
 * 3. **Clean code**: Uses existing PocketFlow infrastructure
 *
 * ## Usage
 *
 * ```typescript
 * class MyNode extends BaseNode<CycleState, CycleParams<C>> {
 *   async exec(state: CycleState) {
 *     // Access services via _params
 *     const { logger, store } = this._params.services;
 *     // Access mutable state from shared
 *     const { messages } = state;
 *   }
 * }
 * ```
 */

import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { IToolRegistry } from '@agent/core/ToolTypes';
import type { TaskRunFileService } from '@utils/files';

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
 */
export interface ToolUseCycleOptions<
  C = unknown,
> extends AgentCycleBaseOptions<C> {
  toolRegistry: IToolRegistry;
  workspaceState: AgentWorkspaceState;
  modelName?: string;
  agentName?: string;
}

// ============================================================================
// SERVICE CONTAINERS
// ============================================================================

/**
 * Base services shared by all cycle flows.
 * Contains immutable dependencies that nodes need.
 */
export interface BaseCycleServices {
  /** Shared store for workspace, round, and run state */
  readonly store: AgentSharedStore;
}

/**
 * Services for response cycle flows.
 * Includes options specific to response generation.
 */
export interface ResponseCycleServices<C = unknown> extends BaseCycleServices {
  /** Response cycle configuration and callbacks */
  readonly options: ResponseCycleOptions<C>;
}

/**
 * Services for tool-use cycle flows.
 * Includes options specific to tool execution.
 */
export interface ToolUseCycleServices<C = unknown> extends BaseCycleServices {
  /** Tool-use cycle configuration and callbacks */
  readonly options: ToolUseCycleOptions<C>;
}

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

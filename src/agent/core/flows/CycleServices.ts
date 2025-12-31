/**
 * Service interfaces and option types for cycle flows.
 *
 * This module defines:
 * 1. Cycle option interfaces (ResponseCycleOptions, ToolUseCycleOptions)
 * 2. Service containers with options flattened directly (no nested wrapper)
 *
 * ## Architecture
 *
 * Services are injected via PocketFlow's `_params` mechanism:
 * - `_params.services` - immutable dependencies (logger, modelHandler, store)
 * - `shared` - mutable runtime state only
 *
 * Options are flattened directly into services for cleaner access:
 * - `services.logger` instead of `services.options.logger`
 * - `services.store` for shared state
 *
 * ## Usage
 *
 * ```typescript
 * class MyNode extends BaseNode<CycleState, CycleParams<C>> {
 *   async exec(state: CycleState) {
 *     // Access services directly (options flattened)
 *     const { logger, store, modelHandler } = this.services;
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
// SERVICE CONTAINERS (flattened - options merged directly into services)
// ============================================================================

/**
 * Base services shared by all cycle flows.
 * Contains shared store and common dependencies.
 */
export interface BaseCycleServices {
  /** Shared store for workspace, round, and run state */
  readonly store: AgentSharedStore;
}

/**
 * Services for response cycle flows.
 *
 * Options are flattened directly into services (no nested `options` wrapper).
 * Access via: `services.logger`, `services.modelHandler`, etc.
 */
export type ResponseCycleServices<C = unknown> = BaseCycleServices &
  Readonly<ResponseCycleOptions<C>>;

/**
 * Services for tool-use cycle flows.
 *
 * Options are flattened directly into services (no nested `options` wrapper).
 * Access via: `services.logger`, `services.toolRegistry`, etc.
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

/**
 * Service interfaces for cycle flows.
 *
 * This module defines the service container pattern for separating
 * immutable dependencies from mutable state in PocketFlow nodes.
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
import type { ResponseCycleOptions } from '@agent/core/ResponseCycle';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';

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
 * Params type for response cycle nodes.
 * Used with BaseNode's `_params` mechanism.
 *
 * Note: Index signature required to satisfy NonIterableObject constraint.
 */
export interface ResponseCycleParams<C = unknown> {
  [key: string]: unknown;
  services: ResponseCycleServices<C>;
}

/**
 * Params type for tool-use cycle nodes.
 * Used with BaseNode's `_params` mechanism.
 *
 * Note: Index signature required to satisfy NonIterableObject constraint.
 */
export interface ToolUseCycleParams<C = unknown> {
  [key: string]: unknown;
  services: ToolUseCycleServices<C>;
}

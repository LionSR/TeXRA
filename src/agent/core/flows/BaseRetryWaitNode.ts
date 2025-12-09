/**
 * Shared retry wait node for manual retry handling.
 * This is the SINGLE SOURCE OF TRUTH for manual retry wait behavior.
 *
 * Both ResponseCycleFlow and ToolUseCycleFlow use this to avoid duplication.
 *
 * ## Architecture
 *
 * This node uses accessors to extract flow-specific values. The accessors
 * receive both `shared` state and `params` to support the services pattern:
 * - Services (options, store) can be accessed via `params.services`
 * - Mutable state (retryState) is in `shared`
 *
 * ## Promise-Based Coordination
 *
 * Instead of registering callbacks with a controller, this node uses
 * the RetryRequestCoordinator's Promise-based API. The coordinator
 * manages the entire lifecycle of the retry request and returns a
 * Promise that resolves when the user acts.
 */

import { BaseNode } from '@agent/node';
import {
  retryCoordinator,
  type RetryResult,
} from '@agent/runtime/RetryRequestCoordinator';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { bus } from '@eventBus/ProgressEventBus';

import { FlowTransition } from './FlowTransitions';
import {
  clearRetryError,
  MANUAL_RETRY_TIMEOUT_MS,
  type RetryState,
} from './RetryState';

/**
 * Minimal interface for shared state that supports manual retry.
 * Both ResponseCycleShared and ToolUseCycleShared satisfy this.
 */
export interface RetryableShared {
  retryState: RetryState;
  state: { shouldStop: boolean };
}

/**
 * Accessors to extract flow-specific values from shared state and params.
 * This allows the base node to work with different flow types.
 *
 * Accessors receive both `shared` and `params` to access:
 * - Mutable state from `shared` (retryState)
 * - Immutable services from `params.services` (options, store)
 */
export interface RetryWaitAccessors<S extends RetryableShared, P = unknown> {
  /** Get the stream ID for UI events and retry registration */
  getStreamId: (shared: S, params: P) => string;
  /** Get the logger for status messages and retry registration */
  getLogger: (shared: S, params: P) => AgentLogger;
  /** Operation name for logging (e.g., "Model invocation", "Tool-use call") */
  operationName: string;
}

/** Index signature type for params constraint */
type ParamsConstraint = { [key: string]: unknown };

/**
 * Creates a retry wait node with the given accessors.
 * This is a factory function that returns a configured BaseNode.
 */
export function createRetryWaitNode<
  S extends RetryableShared,
  P extends ParamsConstraint = ParamsConstraint,
>(accessors: RetryWaitAccessors<S, P>): BaseNode<S, P> {
  return new RetryWaitNode(accessors);
}

/**
 * Shared retry wait node implementation.
 * Handles manual retry by waiting for UI callback with timeout.
 *
 * Uses `_params` to access services via the accessors pattern.
 */
class RetryWaitNode<
  S extends RetryableShared,
  P extends ParamsConstraint = ParamsConstraint,
> extends BaseNode<S, P> {
  private accessors: RetryWaitAccessors<S, P>;

  constructor(accessors: RetryWaitAccessors<S, P>) {
    super();
    this.accessors = accessors;
  }

  /**
   * Pass shared context through to exec.
   * Required because BaseNode.exec receives the result of prep, not shared directly.
   */
  async prep(shared: S): Promise<S> {
    return shared;
  }

  async exec(prepRes: S): Promise<'retry' | 'cancel'> {
    const { retryState } = prepRes;
    const streamId = this.accessors.getStreamId(prepRes, this._params);
    const logger = this.accessors.getLogger(prepRes, this._params);

    // Emit waiting status to UI
    bus.emit('updateStreamStatus', { stream: streamId, status: 'waiting' });

    // Wait for user action via the Promise-based coordinator
    // The coordinator handles:
    // - Emitting 'showRetryRequest' event
    // - Timeout after 5 minutes
    // - Emitting 'resolveRetryRequest' on completion
    const result: RetryResult = await retryCoordinator.waitForUserAction(
      streamId,
      {
        operation: this.accessors.operationName,
        errorMessage: retryState.lastError?.message,
        logger,
        timeoutMs: MANUAL_RETRY_TIMEOUT_MS,
      },
    );

    // Map coordinator result to flow result
    return result.action === 'retry' ? 'retry' : 'cancel';
  }

  async post(
    shared: S,
    _prepRes: S,
    execRes: 'retry' | 'cancel',
  ): Promise<string | undefined> {
    const { retryState, state } = shared;
    const streamId = this.accessors.getStreamId(shared, this._params);
    const logger = this.accessors.getLogger(shared, this._params);

    // Clear error in both cases:
    // - Retry: start fresh for the new attempt
    // - Cancel: distinguishes user cancellation (no error) from error failure
    clearRetryError(retryState);

    if (execRes === 'retry') {
      logger.debug('Manual retry triggered');
      bus.emit('updateStreamStatus', { stream: streamId, status: 'resuming' });
      return FlowTransition.MANUAL_RETRY;
    }

    // User cancelled
    logger.info('Retry cancelled by user', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });
    bus.emit('updateStreamStatus', { stream: streamId, status: 'stopped' });
    state.shouldStop = true;
    return FlowTransition.COMPLETE;
  }
}

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
 * - Mutable state (retryState, retryCallbacks) is in `shared`
 */

import { BaseNode } from '@agent/node';
import {
  registerManualRetry,
  clearManualRetry,
} from '@agent/runtime/ManualRetryController';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { bus } from '@eventBus/ProgressEventBus';

import { FlowTransition } from './FlowTransitions';
import {
  resetRetryState,
  MANUAL_RETRY_TIMEOUT_MS,
  type RetryState,
  type RetryCallbacks,
} from './RetryState';

/**
 * Minimal interface for shared state that supports manual retry.
 * Both ResponseCycleShared and ToolUseCycleShared satisfy this.
 */
export interface RetryableShared {
  retryState: RetryState;
  retryCallbacks: RetryCallbacks;
  state: { shouldStop: boolean };
}

/**
 * Accessors to extract flow-specific values from shared state and params.
 * This allows the base node to work with different flow types.
 *
 * Accessors receive both `shared` and `params` to access:
 * - Mutable state from `shared` (retryState, retryCallbacks)
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

  async exec(shared: S): Promise<'retry' | 'cancel'> {
    const { retryState, retryCallbacks } = shared;
    const streamId = this.accessors.getStreamId(shared, this._params);
    const logger = this.accessors.getLogger(shared, this._params);

    // Log waiting status
    logger.info('Waiting for manual retry', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: { error: retryState.lastError, awaitingManualRetry: true },
    });

    // Emit waiting status to UI
    bus.emit('updateStreamStatus', { stream: streamId, status: 'waiting' });

    // Wait for external signal via callbacks with timeout
    return new Promise<'retry' | 'cancel'>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        clearManualRetry(streamId);
        retryCallbacks.triggerRetry = undefined;
        retryCallbacks.cancelRetry = undefined;
      };

      // Timeout after 5 minutes
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          logger.warn('Manual retry wait timed out after 5 minutes');
          resolve('cancel');
        }
      }, MANUAL_RETRY_TIMEOUT_MS);

      retryCallbacks.triggerRetry = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          cleanup();
          resolve('retry');
        }
      };

      retryCallbacks.cancelRetry = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          cleanup();
          resolve('cancel');
        }
      };

      // Register with ManualRetryController for UI-triggered retries
      registerManualRetry(streamId, {
        run: async () => retryCallbacks.triggerRetry?.(),
        logger,
        operation: this.accessors.operationName,
      });
    });
  }

  async post(
    shared: S,
    _prepRes: unknown,
    execRes: 'retry' | 'cancel',
  ): Promise<string | undefined> {
    const { retryState, state } = shared;
    const streamId = this.accessors.getStreamId(shared, this._params);
    const logger = this.accessors.getLogger(shared, this._params);

    if (execRes === 'retry') {
      resetRetryState(retryState);
      logger.info('Manual retry triggered', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      bus.emit('updateStreamStatus', { stream: streamId, status: 'resuming' });
      return FlowTransition.RETRY;
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

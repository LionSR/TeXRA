/**
 * Shared retry wait node for manual retry handling.
 * This is the SINGLE SOURCE OF TRUTH for manual retry wait behavior.
 *
 * Both ResponseCycleFlow and ToolUseCycleFlow use this to avoid duplication.
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
 * Minimal interface for contexts that support manual retry.
 * Both ResponseCycleContext and ToolUseCycleContext satisfy this.
 */
export interface RetryableContext {
  retryState: RetryState;
  retryCallbacks: RetryCallbacks;
  state: { shouldStop: boolean };
}

/**
 * Accessors to extract flow-specific values from the context.
 * This allows the base node to work with different context types.
 */
export interface RetryWaitAccessors<C extends RetryableContext> {
  /** Get the stream ID for UI events and retry registration */
  getStreamId: (context: C) => string;
  /** Get the logger for status messages and retry registration */
  getLogger: (context: C) => AgentLogger;
  /** Operation name for logging (e.g., "Model invocation", "Tool-use call") */
  operationName: string;
}

/**
 * Creates a retry wait node with the given accessors.
 * This is a factory function that returns a configured BaseNode.
 */
export function createRetryWaitNode<C extends RetryableContext>(
  accessors: RetryWaitAccessors<C>,
): BaseNode<C> {
  return new RetryWaitNode(accessors);
}

/**
 * Shared retry wait node implementation.
 * Handles manual retry by waiting for UI callback with timeout.
 */
class RetryWaitNode<C extends RetryableContext> extends BaseNode<C> {
  private accessors: RetryWaitAccessors<C>;

  constructor(accessors: RetryWaitAccessors<C>) {
    super();
    this.accessors = accessors;
  }

  async exec(context: C): Promise<'retry' | 'cancel'> {
    const { retryState, retryCallbacks } = context;
    const streamId = this.accessors.getStreamId(context);
    const logger = this.accessors.getLogger(context);

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
    context: C,
    _prepRes: unknown,
    execRes: 'retry' | 'cancel',
  ): Promise<string | undefined> {
    const { retryState, state } = context;
    const streamId = this.accessors.getStreamId(context);
    const logger = this.accessors.getLogger(context);

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

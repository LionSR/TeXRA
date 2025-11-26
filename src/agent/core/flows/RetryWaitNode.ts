/**
 * Node that pauses flow execution while awaiting manual retry from user.
 *
 * When entered, this node:
 * 1. Emits 'waiting' status via the event bus
 * 2. Waits for either retry or cancel signal
 * 3. Transitions to RETRY or COMPLETE based on user action
 *
 * The retry/cancel signals are delivered via callbacks stored in the flow context,
 * which the UI layer can invoke. This replaces the global pendingRetries Map.
 */

import { BaseNode } from '@agent/node';
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { bus } from '@eventBus/ProgressEventBus';

import { FlowTransition } from './FlowTransitions';
import { RetryState, resetRetryState } from './RetryState';

/**
 * Callbacks for manual retry control.
 * Store these in your flow context to allow external triggering.
 */
export interface RetryCallbacks {
  /** Call to trigger a retry attempt. */
  triggerRetry?: () => void;
  /** Call to cancel and abort the operation. */
  cancelRetry?: () => void;
}

/**
 * Context required for RetryWaitNode.
 */
export interface RetryWaitContext {
  retryState: RetryState;
  retryCallbacks: RetryCallbacks;
  logger: AgentLogger;
  streamId: StreamTabId;
}

type WaitResult = 'retry' | 'cancel';

/**
 * Node that waits for manual retry signal from user.
 *
 * Usage:
 * ```typescript
 * // In flow setup:
 * retryableNode.on(FlowTransition.AWAIT_RETRY, retryWaitNode);
 * retryWaitNode.on(FlowTransition.RETRY, retryableNode);
 * retryWaitNode.on(FlowTransition.COMPLETE, nextNode);
 *
 * // In UI handler:
 * context.retryCallbacks.triggerRetry?.();
 * ```
 */
export class RetryWaitNode<C extends RetryWaitContext> extends BaseNode<C> {
  async prep(shared: C): Promise<C> {
    return shared;
  }

  async exec(context: C): Promise<WaitResult> {
    const { retryState, logger, streamId } = context;

    // Log that we're waiting for manual retry
    logger.info('Waiting for manual retry', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: {
        error: retryState.lastError,
        awaitingManualRetry: true,
      },
    });

    // Emit waiting status to UI
    bus.emit('updateStreamStatus', {
      stream: streamId,
      status: 'waiting',
    });

    // Wait for external signal via callbacks
    return new Promise<WaitResult>((resolve) => {
      context.retryCallbacks.triggerRetry = () => {
        this.cleanup(context);
        resolve('retry');
      };
      context.retryCallbacks.cancelRetry = () => {
        this.cleanup(context);
        resolve('cancel');
      };
    });
  }

  async post(
    shared: C,
    _prepRes: C,
    execRes: WaitResult,
  ): Promise<string | undefined> {
    const { retryState, logger, streamId } = shared;

    if (execRes === 'retry') {
      // Reset attempt count for fresh retry cycle
      resetRetryState(retryState);
      retryState.attemptCount = 0;

      logger.info('Manual retry triggered', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });

      // Update status back to running
      bus.emit('updateStreamStatus', {
        stream: streamId,
        status: 'resuming',
      });

      return FlowTransition.RETRY;
    }

    // User cancelled
    logger.info('Retry cancelled by user', {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    bus.emit('updateStreamStatus', {
      stream: streamId,
      status: 'stopped',
    });

    return FlowTransition.COMPLETE;
  }

  private cleanup(context: C): void {
    // Clear callbacks to prevent memory leaks
    context.retryCallbacks.triggerRetry = undefined;
    context.retryCallbacks.cancelRetry = undefined;
  }
}

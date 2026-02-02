/** Retry state management: Node retry config, error tracking, and retryable node base class. */

import { SupabaseClient } from '@auth/SupabaseClient';
import {
  MESSAGE_TYPES,
  STREAM_STATUS,
  type RetryErrorInfo,
} from '@shared/schemas';
import { Node, type NonIterableObject } from '@agent/node';
import {
  retryCoordinator,
  type RetryResult,
} from '@agent/runtime/RetryRequestCoordinator';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { formatProviderHttpError } from '@common/errors';
import type { AgentLogger } from '@logger/AgentLogger';
import {
  getModelRetryBackoffMs,
  getModelRetryMaxAttempts,
} from '@utils/config';

const BACKGROUND_MODE_MIN_RETRIES = 3;

export interface RetryState {
  lastError?: RetryErrorInfo;
}

/** Returns maxRetries (1 initial + N auto-retries) and wait (seconds between retries). */
function getNodeRetryConfig(): { maxRetries: number; wait: number } {
  const maxAutoAttempts = getModelRetryMaxAttempts();
  const backoffMs = getModelRetryBackoffMs();

  return {
    maxRetries: 1 + Math.max(0, maxAutoAttempts),
    wait: backoffMs / 1000,
  };
}

interface ManualRetryPromptResult {
  shouldRetry: boolean;
  userCancelled: boolean;
}

/** success: model response | failed: retries exhausted | cancelled: user cancelled | skipped: shouldStop was true */
export type InvocationResult<TSuccess> =
  | ({ kind: 'success' } & TSuccess)
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

interface RetryableNodeServices {
  streamId: string;
  logger: AgentLogger;
  setAbortController: (ac: AbortController | null) => void;
}

/** Base class for model/tool invocation nodes with retry support. */
export abstract class RetryableInvocationNode<
  S,
  P extends NonIterableObject = NonIterableObject,
  Svc extends RetryableNodeServices = RetryableNodeServices,
> extends Node<S, P, Svc> {
  protected _userCancelled = false;
  protected _hasAttemptedTokenRefresh = false;
  protected _persistent401Error: Error | null = null;

  constructor() {
    const config = getNodeRetryConfig();
    super(config.maxRetries, config.wait);
  }

  protected abstract getOperationName(): string;

  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    cloned._hasAttemptedTokenRefresh = false;
    cloned._persistent401Error = null;
    return cloned;
  }

  /** Wraps operation with AbortController; refreshes token once on relay 401 errors. */
  protected async withAbortController<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this._persistent401Error) {
      throw this._persistent401Error;
    }

    const services = this.services;
    let activeController = new AbortController();
    this.signal = activeController.signal;
    services.setAbortController(activeController);

    try {
      return await operation(activeController.signal);
    } catch (err) {
      const formatted = formatProviderHttpError(err);
      if (
        formatted.isRelayError &&
        formatted.statusCode === 401 &&
        !this._hasAttemptedTokenRefresh
      ) {
        this._hasAttemptedTokenRefresh = true;
        services.logger.debug('Relay 401, refreshing token before retry loop');
        const refreshed = await SupabaseClient.getAccessToken();
        if (refreshed) {
          activeController = new AbortController();
          this.signal = activeController.signal;
          services.setAbortController(activeController);
          services.logger.debug('Token refreshed, retrying immediately');
          try {
            return await operation(activeController.signal);
          } catch (retryErr) {
            const retryFormatted = formatProviderHttpError(retryErr);
            if (
              retryFormatted.isRelayError &&
              retryFormatted.statusCode === 401
            ) {
              services.logger.debug(
                'Still 401 after token refresh, skipping auto-retries',
              );
              this._persistent401Error =
                retryErr instanceof Error
                  ? retryErr
                  : new Error(String(retryErr));
            }
            throw retryErr;
          }
        }
      }
      throw err;
    } finally {
      // Clear service reference for GC; keep this.signal for Node._exec() isAborted check
      services.setAbortController(null);
    }
  }

  protected isBackgroundModeActive(): boolean {
    return false;
  }

  async _exec(prepRes: unknown): Promise<unknown> {
    const config = getNodeRetryConfig();
    let maxRetries = config.maxRetries;

    if (this.isBackgroundModeActive()) {
      maxRetries = Math.max(maxRetries, BACKGROUND_MODE_MIN_RETRIES);
    }

    this.maxRetries = maxRetries;
    this.wait = config.wait;
    return super._exec(prepRes);
  }

  async retryPrompt(_prepRes: unknown, error: Error): Promise<boolean> {
    const result = await this.handleManualRetryPrompt(error);

    if (result.userCancelled) {
      this._userCancelled = true;
    }

    if (result.shouldRetry) {
      this._persistent401Error = null;
      this._hasAttemptedTokenRefresh = false;
    }

    return result.shouldRetry;
  }

  protected async handleManualRetryPrompt(
    error: Error,
  ): Promise<ManualRetryPromptResult> {
    const { streamId, logger } = this.services;
    const operationName = this.getOperationName();
    const formatted = formatProviderHttpError(error);

    if (!formatted.retryable) {
      return { shouldRetry: false, userCancelled: false };
    }

    logger.logErrorData(
      `${operationName} failed: ${formatted.message}`,
      formatted,
    );

    StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
    const result: RetryResult = await retryCoordinator.waitForRetry(streamId, {
      operation: operationName,
      errorMessage: formatted.message,
      logger,
      errorDetails: formatted,
    });

    if (result.action === 'retry') {
      logger.debug('Manual retry triggered');
      StreamStatusService.set(streamId, STREAM_STATUS.RESUMING);
      return { shouldRetry: true, userCancelled: false };
    }

    const message =
      result.action === 'timeout'
        ? 'Retry timed out (no response)'
        : 'Retry cancelled by user';
    logger.info(message, { messageType: MESSAGE_TYPES.PROGRESS_STATUS });
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
    return { shouldRetry: false, userCancelled: true };
  }

  protected getFallbackResult(
    error: Error,
  ): { kind: 'cancelled' } | { kind: 'failed'; message: string } {
    if (this._userCancelled) {
      return { kind: 'cancelled' };
    }

    const formatted = formatProviderHttpError(error);
    if (!formatted.retryable) {
      this.services.logger.logErrorData(
        `${this.getOperationName()} failed (not retryable): ${formatted.message}`,
        formatted,
      );
    }
    return { kind: 'failed', message: formatted.message };
  }
}

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

interface InvocationResultHandlerOptions {
  logger: AgentLogger;
  operationName: string;
}

/** Returns narrowed success result or null (flow stopped). Records error for failures. */
export function handleInvocationResult<T extends { response: unknown }>(
  result: InvocationResult<T>,
  state: { shouldStop: boolean; endTurn: boolean },
  retryState: RetryState,
  options: InvocationResultHandlerOptions,
): (T & { kind: 'success' }) | null {
  const { logger, operationName } = options;

  if (result.kind === 'skipped') {
    logger.debug(`${operationName} skipped: shouldStop was already true`);
    return null;
  }

  if (result.kind === 'cancelled') {
    retryState.lastError = undefined;
    state.shouldStop = true;
    state.endTurn = false;
    return null;
  }

  if (result.kind === 'failed') {
    retryState.lastError = { message: result.message, retryable: false };
    state.shouldStop = true;
    state.endTurn = false;
    return null;
  }

  if (!result.response) {
    logger.warn(EMPTY_RESPONSE_ERROR_MESSAGE);
    retryState.lastError = {
      message: EMPTY_RESPONSE_ERROR_MESSAGE,
      retryable: false,
    };
    state.shouldStop = true;
    state.endTurn = false;
    return null;
  }

  retryState.lastError = undefined;
  return result;
}

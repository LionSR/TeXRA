/** Retry state management: Node retry config, error tracking, and retryable node base class. */

import { Node, type NonIterableObject } from '@agent/node';
import { logErrorData, logProgressStatus, type AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { type RetryResult } from '@agent/runtime/RetryRequestCoordinator';
import { waitForRetry } from '@agent/runtime/runCoordinators';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { getConfig } from '@agent/core/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { normalizeProviderError, toErrorMessage } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkErrorUtils';
import { STREAM_STATUS, type RetryErrorInfo } from '@shared/schemas';

const BACKGROUND_MODE_MIN_RETRIES = 3;

export interface RetryState {
  lastError?: RetryErrorInfo;
}

/** Returns maxRetries (1 initial + N auto-retries) and wait (seconds between retries). */
function getNodeRetryConfig(): { maxRetries: number; wait: number } {
  const maxAutoAttempts = getConfig<number>('texra.model.retry.maxAttempts', 1);
  const backoffMs = getConfig<number>('texra.model.retry.backoffMs', 1000);

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
  | { kind: 'failed'; message: string; userRetryable?: boolean }
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

interface RetryableNodeServices {
  streamId: string;
  runtimeHost: AgentRuntimeHost;
  logger: AgentTrace;
  setAbortController: (ac: AbortController | null) => void;
  refreshClient?: () => Promise<void>;
}

/**
 * Attempts to refresh the model client using the provided refreshClient function.
 * Logs success or failure; returns true if refresh was attempted and succeeded.
 */
async function tryRefreshClient(
  refreshClient: (() => Promise<void>) | undefined,
  logger: AgentTrace,
  context: string,
): Promise<boolean> {
  if (!refreshClient) {
    return false;
  }
  try {
    await refreshClient();
    logger.debug(`Refreshed model client ${context}`);
    return true;
  } catch (refreshError) {
    logger.warn(
      `Failed to refresh model client ${context}: ${toErrorMessage(refreshError)}`,
    );
    return false;
  }
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

  /**
   * Attempts a reactive token refresh after a relay 401 error, then retries the operation once.
   * Returns the retry result on success, or rethrows on persistent 401 / refresh failure.
   */
  private async attemptRelay401Recovery<T>(
    originalError: unknown,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const services = this.services;
    this._hasAttemptedTokenRefresh = true;
    services.logger.debug('Relay 401, refreshing token before retry loop');

    const refreshed = await SupabaseClient.getAccessToken(true);
    if (!refreshed) {
      services.logger.debug('Token refresh failed, skipping auto-retries');
      this._persistent401Error =
        originalError instanceof Error
          ? originalError
          : new Error(String(originalError));
      throw originalError;
    }

    await tryRefreshClient(
      services.refreshClient,
      services.logger,
      'after token refresh',
    );

    // Retry with a fresh AbortController
    const retryController = new AbortController();
    this.signal = retryController.signal;
    services.setAbortController(retryController);
    services.logger.debug('Token refreshed, retrying immediately');

    try {
      const result = await operation(retryController.signal);
      // Success — reset flag so future expirations can trigger refresh again
      this._hasAttemptedTokenRefresh = false;
      return result;
    } catch (retryErr) {
      const retryFormatted = normalizeProviderError(retryErr);
      if (retryFormatted.isRelayError && retryFormatted.statusCode === 401) {
        services.logger.debug(
          'Still 401 after token refresh, skipping auto-retries',
        );
        this._persistent401Error =
          retryErr instanceof Error ? retryErr : new Error(String(retryErr));
      }
      throw retryErr;
    }
  }

  /** Wraps operation with AbortController management and relay token refresh. */
  protected async withAbortController<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this._persistent401Error) {
      throw this._persistent401Error;
    }

    const services = this.services;
    const controller = new AbortController();
    this.signal = controller.signal;
    services.setAbortController(controller);

    // Proactive relay token refresh before the request
    if (SupabaseClient.isTokenExpiringSoon()) {
      services.logger.debug(
        'Token nearing expiry, refreshing client proactively',
      );
      await tryRefreshClient(
        services.refreshClient,
        services.logger,
        'proactive pre-invocation',
      );
    }

    try {
      return await operation(controller.signal);
    } catch (err) {
      // Reactive 401 recovery: refresh token and retry once
      const formatted = normalizeProviderError(err);
      if (
        formatted.isRelayError &&
        formatted.statusCode === 401 &&
        !this._hasAttemptedTokenRefresh
      ) {
        return this.attemptRelay401Recovery(err, operation);
      }
      throw err;
    } finally {
      services.setAbortController(null);
    }
  }

  /** Auth/permission errors (401, 403) and credential-exhausted errors
   *  (relay monthly limit, upstream credit/quota depletion) skip auto-retries —
   *  they need human attention (switching keys, topping up). `userRetryable`
   *  only gates the manual retry UI; auto-retry is a stricter subset. */
  shouldAutoRetry(error: Error): boolean {
    if (isUserAbort(error)) return false;

    const formatted = normalizeProviderError(error);
    if (formatted.isCredentialExhausted) return false;
    if (!formatted.userRetryable) return false;
    const code = formatted.statusCode;
    return code !== 401 && code !== 403;
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
      // Always refresh the client on manual retry. The user may have
      // taken actions between failure and retry that change how the
      // client should be built — setting a new API key (quota /
      // credit-depletion flow), toggling included-access mode, rotating
      // a token after a relay 401, etc. Refreshing is cheap and keeps
      // the cached client in sync with current secrets/config.
      await tryRefreshClient(
        this.services.refreshClient,
        this.services.logger,
        'before manual retry',
      );
    }

    return result.shouldRetry;
  }

  protected async handleManualRetryPrompt(
    error: Error,
  ): Promise<ManualRetryPromptResult> {
    const { streamId, logger, runtimeHost } = this.services;
    const operationName = this.getOperationName();
    const formatted = normalizeProviderError(error);

    if (!formatted.userRetryable) {
      return { shouldRetry: false, userCancelled: false };
    }

    logErrorData(
      logger,
      `${operationName} failed: ${formatted.message}`,
      formatted,
    );

    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
      runtimeHost,
    });
    const result: RetryResult = await waitForRetry(streamId, {
      operation: operationName,
      errorMessage: formatted.message,
      logger,
      errorDetails: formatted,
    });

    if (result.action === 'retry') {
      logger.debug('Manual retry triggered');
      StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
        runtimeHost,
      });
      return { shouldRetry: true, userCancelled: false };
    }

    const message =
      result.action === 'timeout'
        ? 'Retry timed out (no response)'
        : 'Retry cancelled by user';
    logProgressStatus(logger, message);
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
      runtimeHost,
    });
    return { shouldRetry: false, userCancelled: true };
  }

  protected getFallbackResult(
    error: Error,
  ):
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string; userRetryable?: boolean } {
    if (this._userCancelled || isUserAbort(error)) {
      return { kind: 'cancelled' };
    }

    const formatted = normalizeProviderError(error);
    if (!formatted.userRetryable) {
      logErrorData(
        this.services.logger,
        `${this.getOperationName()} failed (no retry available): ${formatted.message}`,
        formatted,
      );
    }
    return {
      kind: 'failed',
      message: formatted.message,
      userRetryable: formatted.userRetryable,
    };
  }
}

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

interface InvocationResultHandlerOptions {
  logger: AgentTrace;
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
    retryState.lastError = {
      message: result.message,
      userRetryable: result.userRetryable ?? false,
    };
    state.shouldStop = true;
    state.endTurn = false;
    return null;
  }

  if (!result.response) {
    logger.warn(EMPTY_RESPONSE_ERROR_MESSAGE);
    retryState.lastError = {
      message: EMPTY_RESPONSE_ERROR_MESSAGE,
      userRetryable: false,
    };
    state.shouldStop = true;
    state.endTurn = false;
    return null;
  }

  retryState.lastError = undefined;
  return result;
}

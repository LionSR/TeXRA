/** Retry state management: Node retry config, error tracking, and retryable node base class. */

import { StatusCodes } from 'http-status-codes';

import { Node } from '@agent/node';
import { logErrorData, logProgressStatus, type AgentTrace } from '@agent/trace';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { SupabaseClient } from '@auth/SupabaseClient';
import { normalizeProviderError } from '@common/errors';
import {
  isContextWindowError,
  isUserAbort,
} from '@common/errors/sdkErrorUtils';
import {
  isCredentialExhausted,
  STREAM_PHASE,
  toRetryErrorInfo,
  type RetryErrorInfo,
} from '@shared/schemas';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { ensureError } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';

const BACKGROUND_MODE_MIN_RETRIES = 3;

/** Returns maxRetries (1 initial + N auto-retries) and wait (seconds between retries). */
function getNodeRetryConfig(): { maxRetries: number; wait: number } {
  const maxAutoAttempts = getConfig<number>(
    'texra.model.retry.maxAttempts',
    DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
  );
  const backoffMs = getConfig<number>(
    'texra.model.retry.backoffMs',
    DEFAULT_CORE_SETTINGS.model.retry.backoffMs,
  );

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
  | ({ kind: 'failed' } & RetryErrorInfo)
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

interface RetryableNodeServices {
  streamStatus: StreamStatusMachine;
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
    logger.warn(`Failed to refresh model client ${context}`, {
      data: refreshError,
    });
    return false;
  }
}

/** Base class for model/tool invocation nodes with retry support. */
export abstract class RetryableInvocationNode<
  S,
  Svc extends RetryableNodeServices = RetryableNodeServices,
> extends Node<S, Svc> {
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

    const refreshed = await SupabaseClient.getRelayAccessToken(true);
    if (!refreshed) {
      services.logger.debug('Token refresh failed, skipping auto-retries');
      this._persistent401Error = ensureError(originalError);
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
      if (
        retryFormatted.isRelayError &&
        retryFormatted.statusCode === StatusCodes.UNAUTHORIZED
      ) {
        services.logger.debug(
          'Still 401 after token refresh, skipping auto-retries',
        );
        this._persistent401Error = ensureError(retryErr);
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
        formatted.statusCode === StatusCodes.UNAUTHORIZED &&
        !this._hasAttemptedTokenRefresh
      ) {
        return this.attemptRelay401Recovery(err, operation);
      }
      throw err;
    } finally {
      services.setAbortController(null);
    }
  }

  /** Auth/permission errors (401, 403), credential-exhausted errors (relay
   *  monthly limit, upstream credit/quota depletion), and context-window
   *  overflows skip auto-retries — they need human attention (switching
   *  keys, topping up, shrinking the request) rather than an identical retry
   *  that can only fail the same way again. A provider handler that knows
   *  how to recover from an overflow (e.g. OpenAI Responses' compaction
   *  retry) does so and never lets the error reach this gate; only overflow
   *  errors nobody already recovered from are stopped here. `userRetryable`
   *  only gates the manual retry UI; auto-retry is a stricter subset. */
  shouldAutoRetry(error: Error): boolean {
    if (isUserAbort(error)) return false;
    if (isContextWindowError(error)) return false;

    const formatted = normalizeProviderError(error);
    if (isCredentialExhausted(formatted)) return false;
    if (!formatted.userRetryable) return false;
    const code = formatted.statusCode;
    return code !== StatusCodes.UNAUTHORIZED && code !== StatusCodes.FORBIDDEN;
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
    const { logger, streamStatus } = this.services;
    const { runScope } = useLaunchRunContext();
    const { session, streamId } = runScope;
    const operationName = this.getOperationName();
    const formatted = normalizeProviderError(error);

    if (!formatted.userRetryable) {
      return { shouldRetry: false, userCancelled: false };
    }

    logErrorData(logger, `${operationName} failed`, formatted);

    streamStatus.transition(streamId, STREAM_PHASE.WAITING, 'wait', {
      trace: logger,
    });
    logger.debug('Waiting for manual retry', {
      data: formatted.message ?? 'unknown error',
    });
    // No timeout: the retry panel waits indefinitely for the user's decision.
    const interaction = session.interactions.requestRetry({
      streamId,
      operation: operationName,
      errorMessage: formatted.message,
      errorDetails: formatted,
    });
    if (!interaction) {
      throw new Error('HostInteractions.requestRetry is required');
    }
    const result = await interaction;

    if (result.action === 'retry') {
      logger.debug('Manual retry triggered');
      streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
        trace: logger,
      });
      return { shouldRetry: true, userCancelled: false };
    }

    if (result.action === 'deny') {
      // Policy/headless auto-denial: no human was available to approve the
      // retry (e.g. `--approval-policy never --no-input`). This is a failure,
      // not a user cancel — leaving `userCancelled` false routes it to the
      // `failed` fallback so a zero-output run reports FAILED (surfacing the
      // underlying error), not COMPLETED. Resume to RUNNING first because a
      // WAITING stream can't terminalize directly: the propagating failure is
      // written as the terminal outcome by the run lifecycle. See #7331.
      logProgressStatus(
        logger,
        result.reason ?? 'Retry denied (no human input available)',
      );
      streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
        trace: logger,
      });
      return { shouldRetry: false, userCancelled: false };
    }

    const message =
      result.action === 'timeout'
        ? 'Retry timed out (no response)'
        : 'Retry cancelled by user';
    logProgressStatus(logger, message);
    streamStatus.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop', {
      trace: logger,
    });
    return { shouldRetry: false, userCancelled: true };
  }

  protected getFallbackResult(
    error: Error,
  ): { kind: 'cancelled' } | ({ kind: 'failed' } & RetryErrorInfo) {
    if (this._userCancelled || isUserAbort(error)) {
      return { kind: 'cancelled' };
    }

    const formatted = normalizeProviderError(error);
    if (!formatted.userRetryable) {
      logErrorData(
        this.services.logger,
        `${this.getOperationName()} failed (no retry available)`,
        formatted,
      );
    }
    return {
      kind: 'failed',
      ...toRetryErrorInfo(formatted),
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
  state: { shouldStop: boolean; endTurn: boolean; lastError?: RetryErrorInfo },
  options: InvocationResultHandlerOptions,
): (T & { kind: 'success' }) | null {
  const { logger, operationName } = options;

  if (result.kind === 'skipped') {
    logger.debug(`${operationName} skipped: shouldStop was already true`);
    return null;
  }

  function stop(lastError: RetryErrorInfo | undefined): null {
    state.lastError = lastError;
    state.shouldStop = true;
    state.endTurn = false;
    return null;
  }

  if (result.kind === 'cancelled') {
    return stop(undefined);
  }

  if (result.kind === 'failed') {
    const { kind: _, ...errorInfo } = result;
    return stop(errorInfo);
  }

  if (!result.response) {
    logger.warn(EMPTY_RESPONSE_ERROR_MESSAGE);
    return stop({
      message: EMPTY_RESPONSE_ERROR_MESSAGE,
      userRetryable: false,
    });
  }

  state.lastError = undefined;
  return result;
}

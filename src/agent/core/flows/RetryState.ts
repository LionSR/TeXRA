/** Retry state management: Node retry config, error tracking, and retryable node base class. */

import { Node } from '@agent/node';
import { logErrorData, logProgressStatus, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ModelCell } from '@agent/runtime/ModelCell';
import { createKimiCodeFallbackHandler } from '@agent/runtime/ModelFactory';
import type { RunScope } from '@agent/runtime/RunScope';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import {
  hasContextWindowErrorMarker,
  hasMissingApiKeyErrorMarker,
} from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  isProviderErrorAutoRetryable,
  isUnauthorizedProviderError,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import { includedModelAccess } from '@model/includedModelAccess';
import {
  STREAM_PHASE,
  toRetryErrorInfo,
  type RetryErrorInfo,
} from '@shared/schemas';
import { isKimiCodeExclusiveModel } from '@shared/model/kimiCodeRetryGate';
import {
  DEFAULT_CORE_SETTINGS,
  ModelRetryMaxAttemptsSchema,
} from '@shared/schemas/coreSettings';
import { generateShortId } from '@utils/core';
import { getValidatedConfig } from '@utils/config/configUtils';
import { ensureError } from '@utils/errors/errorMessage';

const BACKGROUND_MODE_MIN_RETRIES = 3;

/**
 * Base delay between node-level retry attempts. `ModelRetryGate` applies its
 * own failure-scaled backoff on top, so this is an implementation constant
 * rather than something a user tunes separately from the attempt count.
 */
export const RETRY_BACKOFF_MS = 1000;

/** One initial attempt plus the configured number of automatic retries. */
function getNodeMaxRetries(): number {
  return (
    1 +
    getValidatedConfig(
      'texra.model.retry.maxAttempts',
      ModelRetryMaxAttemptsSchema,
      DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
    )
  );
}

interface ManualRetryPromptResult {
  shouldRetry: boolean;
  userCancelled: boolean;
  clientPrepared?: boolean;
  retrySource?: RetryAttemptSource;
}

type RetryAttemptSource = 'automatic' | 'human';

interface RetryLifecycleState {
  readonly operationId: string;
  readonly startedAt: number;
  readonly automaticAttemptLimit: number;
  attemptOrdinal: number;
  lastAttemptSource?: RetryAttemptSource;
  nextAttemptSource: RetryAttemptSource;
}

type RetryLifecycleEvent =
  | 'attempt_started'
  | 'attempt_succeeded'
  | 'attempt_failed'
  | 'retry_decision_requested'
  | 'retry_decided';

/**
 * Invocation result after retry handling. A `failed` result has already
 * emitted its canonical error at this boundary; outer cycles only propagate
 * its structured `RetryErrorInfo`.
 */
export type InvocationResult<TSuccess> =
  | ({ kind: 'success' } & TSuccess)
  | ({ kind: 'failed' } & RetryErrorInfo)
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

interface RetryableNodeServices {
  config: Pick<AgentConfig, 'model' | 'agentCategory'>;
  logger: AgentTrace;
  readonly runScope: RunScope;
  /**
   * The run's live client seam. The cell owns the provider client, so a rebind
   * here is the same rebind every other reader of the run observes; a Kimi
   * Code fallback swap ({@link prepareRetryForCredentialSelection}) is
   * likewise visible to every reader.
   */
  readonly modelCell: Pick<
    ModelCell,
    'getClient' | 'rebind' | 'route' | 'handler' | 'swap'
  >;
}

/** Rebuilds the run's client for the configured credential, logging failure. */
async function rebindClient(
  modelCell: Pick<ModelCell, 'rebind'>,
  logger: AgentTrace,
  context: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await modelCell.rebind(undefined, signal);
    logger.debug(`Refreshed model client ${context}`);
  } catch (rebindError) {
    logger.warn(`Failed to refresh model client ${context}`, {
      data: rebindError,
    });
  }
}

/**
 * Prepare the run's client for a credential-selecting retry. Most selections
 * only need a rebind: the live handler re-resolves credential and endpoint
 * from the current settings. The exception is a dual-backend Kimi model whose
 * handler was dispatched onto the Kimi Code coding endpoint — its synthesized
 * config pins the coding `baseUrl` and wire id, so a rebind would resolve the
 * same exhausted Kimi Code credential again. For a 'personal' selection the
 * host has already disabled the plan preference, so rebuild the handler from
 * the registry config and swap it in (the mid-run replacement the model
 * switcher also uses); the next attempt then builds its client against the
 * Moonshot fallback.
 */
async function prepareRetryForCredentialSelection(
  services: RetryableNodeServices,
  selection: ModelCredentialSelection,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { modelCell } = services;
  if (selection !== 'personal') {
    await modelCell.rebind(selection, signal);
    return;
  }
  const fallback = await createKimiCodeFallbackHandler(
    modelCell.handler.config,
    services.config.model,
    services.runScope.session.responseTextProcessing,
  );
  if (!fallback) {
    await modelCell.rebind(selection, signal);
    return;
  }
  fallback.setAgentCategory(services.config.agentCategory);
  fallback.setLogger(services.logger);
  try {
    signal?.throwIfAborted();
  } catch (error) {
    fallback.dispose();
    throw error;
  }
  modelCell.swap(fallback, services.config.model);
}

/** Base class for model/tool invocation nodes with retry support. */
export abstract class RetryableInvocationNode<
  S,
  Svc extends RetryableNodeServices = RetryableNodeServices,
> extends Node<S, Svc> {
  protected _userCancelled = false;
  protected _hasAttemptedTokenRefresh = false;
  protected _persistent401Error: Error | null = null;
  private _retryLifecycle: RetryLifecycleState | undefined;

  constructor() {
    super(getNodeMaxRetries(), RETRY_BACKOFF_MS / 1000);
  }

  protected abstract getOperationName(): string;

  /** Whether a resolved provider result is valid at the concrete boundary. */
  protected isSuccessfulInvocationResult(_result: unknown): boolean {
    return true;
  }

  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    cloned._hasAttemptedTokenRefresh = false;
    cloned._persistent401Error = null;
    cloned._retryLifecycle = undefined;
    return cloned;
  }

  /** Emit compact diagnostic data for durable, non-presentational recording. */
  private logRetryLifecycle(
    event: RetryLifecycleEvent,
    details: Record<string, unknown> = {},
  ): void {
    const lifecycle = this._retryLifecycle;
    if (!lifecycle) return;
    const { runScope, modelCell } = this.services;
    this.services.logger.domain({
      key: 'modelRetryLifecycle',
      data: {
        kind: 'model_retry_lifecycle',
        event,
        operationId: lifecycle.operationId,
        operation: this.getOperationName(),
        executionId: runScope.executionId,
        streamId: runScope.streamId,
        agentName: runScope.agentName,
        model: this.services.config.model,
        credentialRoute: modelCell.route,
        attemptOrdinal: lifecycle.attemptOrdinal,
        automaticAttemptLimit: lifecycle.automaticAttemptLimit,
        elapsedMs: Date.now() - lifecycle.startedAt,
        ...details,
      },
    });
  }

  /** Record the concrete boundary's classification without changing its result. */
  private recordResolvedAttempt<T>(
    result: T,
    attemptSource: RetryAttemptSource,
    details: Record<string, unknown> = {},
  ): T {
    if (this.isSuccessfulInvocationResult(result)) {
      this.logRetryLifecycle('attempt_succeeded', {
        decisionSource: attemptSource,
        ...details,
      });
    } else {
      this.logRetryLifecycle('attempt_failed', {
        decisionSource: attemptSource,
        failureKind: 'invalid_result',
        ...details,
      });
    }
    return result;
  }

  /**
   * Attempts a reactive token refresh after a relay 401 error, then retries the operation once.
   * Returns the retry result on success, or rethrows on persistent 401 / refresh failure.
   */
  private async attemptRelay401Recovery<T>(
    originalError: unknown,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const services = this.services;
    this._hasAttemptedTokenRefresh = true;
    services.logger.debug('Relay 401, refreshing token before retry loop');

    const refreshed = await includedModelAccess().getAccessToken(true);
    if (!refreshed) {
      services.logger.debug('Token refresh failed, skipping auto-retries');
      this._persistent401Error = ensureError(originalError);
      throw originalError;
    }

    await rebindClient(
      services.modelCell,
      services.logger,
      'after token refresh',
      signal,
    );

    services.logger.debug('Token refreshed, retrying immediately');

    try {
      const result = await operation(signal);
      // Success — reset flag so future expirations can trigger refresh again
      this._hasAttemptedTokenRefresh = false;
      return result;
    } catch (retryErr) {
      const retryFormatted = normalizeProviderError(retryErr);
      if (
        retryFormatted.isRelayError &&
        isUnauthorizedProviderError(retryFormatted)
      ) {
        services.logger.debug(
          'Still 401 after token refresh, skipping auto-retries',
        );
        this._persistent401Error = ensureError(retryErr);
      }
      throw retryErr;
    }
  }

  /** Runs the operation under the run signal, with relay token refresh. */
  protected async invokeWithRelayRecovery<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const services = this.services;
    const signal = services.runScope.signal;
    const lifecycle = this._retryLifecycle;
    const attemptSource = lifecycle?.nextAttemptSource ?? 'automatic';
    if (lifecycle) {
      lifecycle.attemptOrdinal += 1;
      lifecycle.lastAttemptSource = attemptSource;
      lifecycle.nextAttemptSource = 'automatic';
    }
    this.logRetryLifecycle('attempt_started', {
      decisionSource: attemptSource,
    });

    try {
      if (this._persistent401Error) {
        throw this._persistent401Error;
      }

      // Build (or reuse) the client this attempt will run on before reading
      // the credential route it captured. Client preparation is part of the
      // retry attempt and must therefore remain inside this lifecycle guard.
      await services.modelCell.getClient();

      // Proactive relay token refresh before the request. Only relay-route
      // clients present a relay session token, so only they consult the expiry
      // clock — personal-key / openrouter / subscription clients must never
      // rebuild for a credential the call doesn't use.
      const includedAccess = includedModelAccess();
      if (
        services.modelCell.route === 'relay' &&
        includedAccess.isAccessTokenExpiringSoon()
      ) {
        // Threshold-gated and mutex-deduped: refreshes the session (updating
        // tokenExpiresAt) only when actually near expiry. For a configured CI
        // relay token this is a cache-only read with no side effects.
        await includedAccess.getAccessToken();
        // Rebuild only when the token actually rotated — rebuilding with the
        // same JWT changes nothing, and is exactly the loop this branch caused.
        if (!includedAccess.isAccessTokenExpiringSoon()) {
          await rebindClient(
            services.modelCell,
            services.logger,
            'proactive pre-invocation',
            signal,
          );
        }
      }

      const result = await operation(signal);
      return this.recordResolvedAttempt(result, attemptSource);
    } catch (err) {
      const formatted = normalizeProviderError(err);
      // Reactive 401 recovery: refresh token (single-flighted at the auth
      // boundary) and retry once within this same node attempt. 401 is not
      // auto-retryable, so without this the run would halt at the manual
      // retry prompt on every token rotation.
      if (
        (formatted.isRelayError || services.modelCell.route === 'relay') &&
        isUnauthorizedProviderError(formatted) &&
        !this._hasAttemptedTokenRefresh
      ) {
        this.logRetryLifecycle('attempt_failed', {
          decisionSource: attemptSource,
          credentialRefresh: true,
          recoveryPending: true,
          userRetryable: formatted.userRetryable,
          statusCode: formatted.statusCode,
          provider: formatted.provider,
          isRelayError: formatted.isRelayError,
        });
        try {
          const result = await this.attemptRelay401Recovery(
            err,
            operation,
            signal,
          );
          return this.recordResolvedAttempt(result, attemptSource, {
            credentialRefresh: true,
          });
        } catch (retryErr) {
          const retryFormatted = normalizeProviderError(retryErr);
          this.logRetryLifecycle('attempt_failed', {
            decisionSource: attemptSource,
            credentialRefresh: true,
            userRetryable: retryFormatted.userRetryable,
            statusCode: retryFormatted.statusCode,
            provider: retryFormatted.provider,
            isRelayError: retryFormatted.isRelayError,
          });
          throw retryErr;
        }
      }
      this.logRetryLifecycle('attempt_failed', {
        decisionSource: attemptSource,
        userRetryable: formatted.userRetryable,
        statusCode: formatted.statusCode,
        provider: formatted.provider,
        isRelayError: formatted.isRelayError,
      });
      throw err;
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
    return isProviderErrorAutoRetryable(error);
  }

  protected isBackgroundModeActive(): boolean {
    return false;
  }

  async _exec(prepRes: unknown): Promise<unknown> {
    this._userCancelled = false;
    let maxRetries = getNodeMaxRetries();

    if (this.isBackgroundModeActive()) {
      maxRetries = Math.max(maxRetries, BACKGROUND_MODE_MIN_RETRIES);
    }

    this.maxRetries = maxRetries;
    this._retryLifecycle = {
      operationId: `model-operation-${generateShortId()}`,
      startedAt: Date.now(),
      automaticAttemptLimit: maxRetries,
      attemptOrdinal: 0,
      nextAttemptSource: 'automatic',
    };
    // This local delay is the fallback for retryable failures that do not
    // implicate a shared route. For classified route failures it overlaps the
    // gate's cooling interval, so the gate waits only for any remaining time.
    this.wait = RETRY_BACKOFF_MS / 1000;
    // The run's one interrupt controller drives the retry loop's abort
    // handling; an interrupt is read back off the same signal in
    // `getFallbackResult`, so there is nothing to register or clear here.
    this.signal = this.services.runScope.signal;
    return await super._exec(prepRes);
  }

  async retryPrompt(_prepRes: unknown, error: Error): Promise<boolean> {
    if (isUserAbort(error)) return false;
    // A missing credential cannot be fixed by retrying; fail immediately.
    if (hasMissingApiKeyErrorMarker(error)) return false;

    const result = await this.handleManualRetryPrompt(error);

    if (result.userCancelled) {
      this._userCancelled = true;
    }

    if (result.shouldRetry) {
      if (this._retryLifecycle) {
        this._retryLifecycle.nextAttemptSource = result.retrySource ?? 'human';
      }
      this._persistent401Error = null;
      this._hasAttemptedTokenRefresh = false;
      // Always refresh the client on manual retry. The user may have
      // taken actions between failure and retry that change how the
      // client should be built — setting a new API key (quota /
      // credit-depletion flow), toggling included-access mode, rotating
      // a token after a relay 401, etc. Refreshing is cheap and keeps
      // the cached client in sync with current secrets/config.
      if (result.clientPrepared !== true) {
        await rebindClient(
          this.services.modelCell,
          this.services.logger,
          'before manual retry',
        );
      }
    }

    return result.shouldRetry;
  }

  protected async handleManualRetryPrompt(
    error: Error,
  ): Promise<ManualRetryPromptResult> {
    const { logger, runScope } = this.services;
    const { session, streamId } = runScope;
    const streamStatus = session.status;
    const operationName = this.getOperationName();
    const formatted = normalizeProviderError(error);

    if (!formatted.userRetryable) {
      return { shouldRetry: false, userCancelled: false };
    }

    this.logRetryLifecycle('retry_decision_requested', {
      afterAttemptSource: this._retryLifecycle?.lastAttemptSource,
      userRetryable: formatted.userRetryable,
      statusCode: formatted.statusCode,
      provider: formatted.provider,
    });

    logErrorData(logger, `${operationName} failed`, formatted);

    streamStatus.transition(streamId, STREAM_PHASE.WAITING, 'wait');
    logger.debug('Waiting for manual retry', {
      data: formatted.message ?? 'unknown error',
    });
    // No timeout: the retry panel waits indefinitely for the user's decision.
    let clientPrepared = false;
    // Capture the failed handler's effective route before the retry panel can
    // be outlived by routing-preference changes. A dual-backend Kimi handler
    // dispatched onto the coding endpoint carries the pinned Kimi Code
    // `baseUrl`, so the shared field predicate is true for that runtime config
    // even though the registry entry itself is not coding-exclusive.
    const kimiCodeRoutedOnFailure = isKimiCodeExclusiveModel(
      this.services.modelCell.handler.config,
    );
    const interaction = session.interactions.requestRetry(
      {
        requestId: `retry-${generateShortId()}`,
        streamId,
        operation: operationName,
        model: this.services.config.model,
        errorMessage: formatted.message,
        errorDetails: formatted,
        kimiCodeRoutedOnFailure,
      },
      {
        prepareRetry: async (selection, signal) => {
          await prepareRetryForCredentialSelection(
            this.services,
            selection,
            signal,
          );
          clientPrepared = true;
        },
      },
    );
    if (!interaction) {
      throw new Error('HostInteractions.requestRetry is required');
    }
    const result = await interaction;
    const retrySource =
      result.action === 'retry'
        ? (result.decisionSource ?? 'human')
        : undefined;
    const decisionSource =
      retrySource ?? (result.action === 'deny' ? 'denied' : 'cancelled');
    this.logRetryLifecycle('retry_decided', {
      action: result.action,
      decisionSource,
    });

    if (result.action === 'retry') {
      logger.debug('Manual retry triggered');
      streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume');
      return {
        shouldRetry: true,
        userCancelled: false,
        clientPrepared,
        retrySource,
      };
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
      streamStatus.transition(streamId, STREAM_PHASE.RUNNING, 'resume');
      return { shouldRetry: false, userCancelled: false };
    }

    logProgressStatus(logger, 'Retry cancelled by user');
    streamStatus.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');
    return { shouldRetry: false, userCancelled: true };
  }

  protected getFallbackResult(
    error: Error,
  ): { kind: 'cancelled' } | ({ kind: 'failed' } & RetryErrorInfo) {
    if (
      this._userCancelled ||
      this.services.runScope.signal.aborted ||
      isUserAbort(error)
    ) {
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
      // The markers ride the Error, not the formatted record; stamp them here
      // so the flow-exit classifier can still see them (the carried-error
      // exit rebuilds a bare Error in toFlowFailureError).
      ...(hasMissingApiKeyErrorMarker(error) ? { missingApiKey: true } : {}),
      ...(hasContextWindowErrorMarker(error) ? { contextWindow: true } : {}),
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
  state: {
    shouldStop: boolean;
    endTurn: boolean;
    lastError?: RetryErrorInfo;
  },
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
    const errorInfo = {
      message: EMPTY_RESPONSE_ERROR_MESSAGE,
      userRetryable: false,
    };
    logErrorData(logger, `${operationName} failed`, errorInfo);
    return stop(errorInfo);
  }

  state.lastError = undefined;
  return result;
}

/**
 * The model invocation node and everything its retry lifecycle owns: node-level
 * retry configuration, the shared-route recovery gate, relay credential
 * recovery, the manual retry prompt, and the cancelled/failed fallbacks — one
 * deep module behind the plain `Node` interface the cycle flows compose.
 */

import { Node } from '@agent/node';
import { logErrorData, logProgressStatus, type AgentTrace } from '@agent/trace';
import type { AgentCore } from '@agent/core/flows/BaseFlowServices';
import {
  type BaseInvocationPrepResult,
  type BaseInvocationSuccessData,
  type BaseCycleFields,
  type CycleDebugFileOptions,
  replaceMessagesInPlace,
  saveCycleDebug,
} from '@agent/core/flows/CommonCycleTypes';
import type { FinalTool } from '@agent/types/ModelHandlerContracts';
import { createKimiCodeFallbackHandler } from '@agent/runtime/ModelFactory';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import {
  hasContextWindowErrorMarker,
  hasMissingApiKeyErrorMarker,
} from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  classifyModelRouteFailure,
  isProviderErrorAutoRetryable,
  isUnauthorizedProviderError,
  normalizeProviderError,
  type ModelRouteVerdict,
} from '@common/errors/sdkError/providerErrorFormat';
import { includedModelAccess } from '@model/includedModelAccess';
import type { ResolvedModelConfig } from '@model/openRouterRouting';
import {
  DEFAULT_CORE_SETTINGS,
  ModelRetryMaxAttemptsSchema,
  STREAM_PHASE,
  toRetryErrorInfo,
  type RetryErrorInfo,
  type ToolDefinition,
} from '@shared/schemas';
import { isKimiCodeExclusiveModel } from '@shared/model/kimiCodeRetryGate';
import { generateShortId } from '@utils/core';
import { getValidatedConfig } from '@utils/config/configUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { FlowTransition } from './FlowTransitions';

const BACKGROUND_MODE_MIN_RETRIES = 3;

const RELAY_USER_REQUEST_GATE_ROUTE = 'relay:user-request-gate';

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/**
 * Base delay between node-level retry attempts. `ModelRetryGate` applies its
 * own failure-scaled backoff on top, so this is an implementation constant
 * rather than something a user tunes separately from the attempt count.
 */
const RETRY_BACKOFF_MS = 1000;

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

/** The failed handler's effective config and model id, captured from the
 *  live cell as one pair when the retry panel opens. */
interface FailedModelIdentity {
  readonly config: ResolvedModelConfig;
  readonly modelId: string;
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

/** A provider attempt that resolved with a response. */
export type InvocationSuccess = { kind: 'success' } & BaseInvocationSuccessData;

/**
 * Invocation result after retry handling. A `failed` result has already
 * emitted its canonical error at this boundary; outer cycles only propagate
 * its structured `RetryErrorInfo`.
 */
export type InvocationResult =
  | InvocationSuccess
  | ({ kind: 'failed' } & RetryErrorInfo)
  | { kind: 'cancelled' }
  | { kind: 'skipped' };

export interface ModelInvocationConfig<TShared, TServices> {
  operationName: string;
  streaming: boolean;
  backgroundModeAware?: boolean;
  getSystemPrompt?: (
    shared: TShared,
    services: TServices,
  ) => string | undefined;
  getEndTag?: (services: TServices) => string | undefined;
  getTools?: (services: TServices) => ToolDefinition[] | undefined;
  getFinalTool?: (
    shared: TShared,
    services: TServices,
  ) => FinalTool | undefined;
  storeResponse: (shared: TShared, response: unknown) => void;
  /**
   * Called after compaction to get additional context (e.g. active executions)
   * to append to the compacted messages. Returns the context string to inject
   * as a user follow-up message, or null if no context is needed.
   */
  getPostCompactionContext?: (services: TServices) => string | null;
  getDebugFileOptions?: (
    shared: TShared,
    services: TServices,
  ) => CycleDebugFileOptions;
}

/**
 * Only the services this node reads: the model cell (handler and live provider
 * client), logger, setting (temperature/tools), config (model identity plus
 * `saveCycleDebug`'s log context), and the run scope (retry gate, abort signal,
 * and debug-log identity).
 */
type InvocationServices = Pick<
  AgentCore,
  'modelCell' | 'logger' | 'setting' | 'config' | 'runScope'
>;

export class ModelInvocationNode<
  TShared extends BaseCycleFields,
  TServices extends InvocationServices = InvocationServices,
> extends Node<TShared, TServices> {
  private readonly _config: ModelInvocationConfig<TShared, TServices>;
  protected _userCancelled = false;
  protected _hasAttemptedTokenRefresh = false;
  protected _persistent401Error: Error | null = null;
  private _retryLifecycle: RetryLifecycleState | undefined;

  constructor(config: ModelInvocationConfig<TShared, TServices>) {
    super(getNodeMaxRetries(), RETRY_BACKOFF_MS / 1000);
    this._config = config;
  }

  clone(): this {
    const cloned = super.clone();
    cloned._userCancelled = false;
    cloned._hasAttemptedTokenRefresh = false;
    cloned._persistent401Error = null;
    cloned._retryLifecycle = undefined;
    return cloned;
  }

  /** Rebuilds the run's client for the configured credential, logging failure. */
  private async rebindClient(
    context: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { logger, modelCell } = this.services;
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
   * the failed model's registry config and swap it in (the mid-run replacement
   * the model switcher also uses); the next attempt then builds its client
   * against the Moonshot fallback. Both the rebuild probe and the swap id come
   * from the `failedModel` pair captured when the panel opened.
   */
  private async prepareRetryForCredentialSelection(
    selection: ModelCredentialSelection,
    signal: AbortSignal | undefined,
    failedModel: FailedModelIdentity,
  ): Promise<void> {
    const { modelCell } = this.services;
    if (selection !== 'personal') {
      await modelCell.rebind(selection, signal);
      return;
    }
    const fallback = await createKimiCodeFallbackHandler(
      failedModel.config,
      failedModel.modelId,
      this.services.runScope.session.responseTextProcessing,
    );
    // A model switch is allowed while the retry panel waits, and the fallback
    // build above is async: if the cell no longer holds the captured pair,
    // swapping would silently undo the user's newer switch. Dispose the
    // stale fallback and prepare the handler that is actually live instead.
    if (
      modelCell.handler.config !== failedModel.config ||
      modelCell.modelId !== failedModel.modelId
    ) {
      fallback?.dispose();
      await modelCell.rebind(selection, signal);
      return;
    }
    if (!fallback) {
      await modelCell.rebind(selection, signal);
      return;
    }
    fallback.setAgentCategory(this.services.config.agentCategory);
    fallback.setLogger(this.services.logger);
    try {
      signal?.throwIfAborted();
    } catch (error) {
      fallback.dispose();
      throw error;
    }
    modelCell.swap(fallback, failedModel.modelId);
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
        operation: this._config.operationName,
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

  /** Record the resolved attempt's classification without changing its result. */
  private recordResolvedAttempt(
    result: InvocationSuccess,
    attemptSource: RetryAttemptSource,
    details: Record<string, unknown> = {},
  ): InvocationSuccess {
    // An empty response resolves the provider call but carries nothing the
    // cycle can use, so the lifecycle records it as a failed attempt.
    if (result.response) {
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
  private async attemptRelay401Recovery(
    originalError: unknown,
    operation: (signal: AbortSignal) => Promise<InvocationSuccess>,
    signal: AbortSignal,
  ): Promise<InvocationSuccess> {
    const { logger } = this.services;
    this._hasAttemptedTokenRefresh = true;
    logger.debug('Relay 401, refreshing token before retry loop');

    const refreshed = await includedModelAccess().getAccessToken(true);
    if (!refreshed) {
      logger.debug('Token refresh failed, skipping auto-retries');
      this._persistent401Error = ensureError(originalError);
      throw originalError;
    }

    await this.rebindClient('after token refresh', signal);

    logger.debug('Token refreshed, retrying immediately');

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
        logger.debug('Still 401 after token refresh, skipping auto-retries');
        this._persistent401Error = ensureError(retryErr);
      }
      throw retryErr;
    }
  }

  /** Runs the operation under the run signal, with relay token refresh. */
  protected async invokeWithRelayRecovery(
    operation: (signal: AbortSignal) => Promise<InvocationSuccess>,
  ): Promise<InvocationSuccess> {
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
          await this.rebindClient('proactive pre-invocation', signal);
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

  async _exec(prepRes: unknown): Promise<unknown> {
    this._userCancelled = false;
    let maxRetries = getNodeMaxRetries();

    if (
      this._config.backgroundModeAware === true &&
      this.services.modelCell.handler.isBackgroundModeActive()
    ) {
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
        await this.rebindClient('before manual retry');
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
    const operationName = this._config.operationName;
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
    // The failed handler's config and model id, captured as one pair from
    // the live cell: the cell keeps handler and id coherent, while
    // `services.config.model` is the immutable launch config a mid-run
    // `switchModel` leaves stale. The request below — and a fallback rebuild
    // if the user accepts with personal credentials — must describe the
    // handler that actually failed, so all of them read this pair.
    const failedModel: FailedModelIdentity = {
      config: this.services.modelCell.handler.config,
      modelId: this.services.modelCell.modelId,
    };
    // Capture the failed handler's effective route before the retry panel can
    // be outlived by routing-preference changes. A dual-backend Kimi handler
    // dispatched onto the coding endpoint carries the pinned Kimi Code
    // `baseUrl`, so the shared field predicate is true for that runtime config
    // even though the registry entry itself is not coding-exclusive.
    const kimiCodeRoutedOnFailure = isKimiCodeExclusiveModel(
      failedModel.config,
    );
    const interaction = session.interactions.requestRetry(
      {
        requestId: `retry-${generateShortId()}`,
        streamId,
        operation: operationName,
        model: failedModel.modelId,
        errorMessage: formatted.message,
        errorDetails: formatted,
        kimiCodeRoutedOnFailure,
      },
      {
        prepareRetry: async (selection, signal) => {
          await this.prepareRetryForCredentialSelection(
            selection,
            signal,
            failedModel,
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
        `${this._config.operationName} failed (no retry available)`,
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

  async prep(shared: TShared): Promise<BaseInvocationPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      messages: shared.messages,
      systemPrompt: this._config.getSystemPrompt?.(shared, this.services),
      finalTool: this._config.getFinalTool?.(shared, this.services),
    };
  }

  async exec(prepRes: BaseInvocationPrepResult): Promise<InvocationResult> {
    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    const services = this.services;
    const modelHandler = services.modelCell.handler;
    modelHandler.setOutputStreaming(this._config.streaming);

    return this.invokeWithRelayRecovery(async (signal) => {
      // Read per attempt: a retry that rebound the credential must run on the
      // replacement client, not the one the failed attempt used.
      const client = await services.modelCell.getClient();
      const wireRoute = modelHandler.getWireRouteKey(client);
      const modelRetryRoute = modelHandler.getModelRetryRouteKey(client);
      const gate = services.runScope.session.modelRetries;
      const usesRelay = services.modelCell.route === 'relay';
      // The three routes ask different questions of the same failure, so the
      // verdict is computed once per failed call and read by each of them.
      let classified: { error: Error; verdict: ModelRouteVerdict } | undefined;
      const verdictFor = (error: Error): ModelRouteVerdict => {
        if (classified?.error !== error) {
          classified = { error, verdict: classifyModelRouteFailure(error) };
        }
        return classified.verdict;
      };
      const isRelayAdmissionFailure = (error: Error): boolean => {
        const { rateLimitScope } = verdictFor(error);
        return (
          rateLimitScope === 'relay-limit' || rateLimitScope === 'relay-user'
        );
      };
      const invoke = async () => {
        const start = Date.now();
        const result = await modelHandler.createResponse({
          client,
          messages: prepRes.messages,
          temperature: services.setting.temperature,
          systemPrompt: prepRes.systemPrompt,
          endTag: this._config.getEndTag?.(services),
          signal,
          tools: this._config.getTools
            ? this._config.getTools(services)
            : services.setting.tools,
          finalTool: prepRes.finalTool,
        });

        return {
          kind: 'success' as const,
          response: result.response,
          responseTimeMs: Date.now() - start,
          updatedMessages: result.updatedMessages,
        };
      };

      return gate.run(
        wireRoute,
        {
          signal,
          baseBackoffMs: RETRY_BACKOFF_MS,
          // One wire route owns transport and server-failure cooling. A second
          // ordered scope keeps model-specific limits from blocking healthy
          // sibling models on the same credential and endpoint. Relay calls
          // also share the server's cross-provider per-user request gate.
          classifyFailure: (error) => {
            const verdict = verdictFor(error);
            return verdict.wireRouteFailure
              ? { retryAfterMs: verdict.retryAfterMs }
              : undefined;
          },
          isReachableFailure: (error) =>
            verdictFor(error).rateLimitScope === 'model',
          isUnobservedFailure: isRelayAdmissionFailure,
          additionalRoutes: [
            {
              key: modelRetryRoute,
              classifyFailure: (error) => {
                const verdict = verdictFor(error);
                return verdict.rateLimitScope === 'model'
                  ? { retryAfterMs: verdict.retryAfterMs }
                  : undefined;
              },
              isUnobservedFailure: isRelayAdmissionFailure,
            },
          ],
          trailingRoutes: usesRelay
            ? [
                {
                  key: RELAY_USER_REQUEST_GATE_ROUTE,
                  classifyFailure: (error) => {
                    const verdict = verdictFor(error);
                    if (verdict.rateLimitScope !== 'relay-user') {
                      return undefined;
                    }
                    return {
                      retryAfterMs: verdict.relayRequestRetryAfterMs,
                      ...(verdict.relayRequestRateLimited
                        ? { releaseProbeBeforeOperation: true }
                        : {}),
                    };
                  },
                  // An upstream rate limit proves the gate admitted the call.
                  isReachableFailure: (error) => {
                    const { rateLimitScope } = verdictFor(error);
                    return (
                      rateLimitScope === 'model' || rateLimitScope === 'wire'
                    );
                  },
                  // The relay rejected the call before its per-user gate.
                  isUnobservedFailure: (error) =>
                    verdictFor(error).exhaustionReason === 'relay-limit',
                  releaseEarlierProbesBeforeWait: true,
                },
              ]
            : undefined,
          onWait: (delayMs) =>
            services.logger.debug(
              `Waiting ${delayMs}ms for the model recovery probe.`,
            ),
        },
        invoke,
      );
    });
  }

  async execFallback(
    _prepRes: BaseInvocationPrepResult,
    error: Error,
  ): Promise<InvocationResult> {
    return this.getFallbackResult(error);
  }

  async post(
    shared: TShared,
    _prepRes: BaseInvocationPrepResult,
    execRes: InvocationResult,
  ): Promise<string | undefined> {
    const successRes = handleInvocationResult(execRes, shared, {
      logger: this.services.logger,
      operationName: this._config.operationName,
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    if (successRes.updatedMessages != null) {
      replaceMessagesInPlace(shared.messages, successRes.updatedMessages);

      // After compaction, inject active execution context so the agent knows
      // about running subagents/background processes it launched pre-compaction.
      if (this._config.getPostCompactionContext) {
        const context = this._config.getPostCompactionContext(this.services);
        if (context) {
          shared.messages =
            await this.services.modelCell.handler.createUserFollowUpMessages(
              shared.messages,
              context,
            );
        }
      }
    }

    shared.responseTimeMs = successRes.responseTimeMs;
    this._config.storeResponse(shared, successRes.response);

    if (this._config.getDebugFileOptions) {
      const fileOptions = this._config.getDebugFileOptions(
        shared,
        this.services,
      );
      await saveCycleDebug(
        successRes.response,
        'response',
        this.services,
        fileOptions,
      );
    }

    return FlowTransition.DEFAULT;
  }
}

interface InvocationResultHandlerOptions {
  logger: AgentTrace;
  operationName: string;
}

/** Returns narrowed success result or null (flow stopped). Records error for failures. */
export function handleInvocationResult(
  result: InvocationResult,
  state: {
    shouldStop: boolean;
    endTurn: boolean;
    lastError?: RetryErrorInfo;
  },
  options: InvocationResultHandlerOptions,
): InvocationSuccess | null {
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

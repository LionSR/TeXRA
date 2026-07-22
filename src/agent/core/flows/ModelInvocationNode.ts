import {
  type BaseInvocationPrepResult,
  type BaseInvocationSuccessData,
  type BaseCycleFields,
  type CycleDebugFileOptions,
  replaceMessagesInPlace,
  saveCycleDebug,
} from '@agent/core/flows/CommonCycleTypes';
import type {
  AgentCore,
  BaseFlowContextInit,
} from '@agent/core/flows/BaseFlowServices';
import type {
  FinalTool,
  ModelCredentialRoute,
  ModelCredentialSelection,
} from '@agent/types/ModelHandlerContracts';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import { detectStatusCode } from '@common/errors/sdkErrorUtils';
import type { ToolDefinition } from '@model';
import { isObject } from '@utils/core';

import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';

const TRANSPORT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function errorCauseChain(error: Error): unknown[] {
  const chain: unknown[] = [];
  for (
    let current: unknown = error;
    isObject(current);
    current = (current as { cause?: unknown }).cause
  ) {
    chain.push(current);
  }
  return chain;
}

/** Classify only failures that carry evidence about a shared wire route. */
function classifyModelRouteFailure(
  error: Error,
  credentialRoute: ModelCredentialRoute | undefined,
): { retryAfterMs?: number } | undefined {
  const chain = errorCauseChain(error);
  const candidates = chain.map((current) => {
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : '',
      name: typeof candidate.name === 'string' ? candidate.name : '',
      message: typeof candidate.message === 'string' ? candidate.message : '',
    };
  });
  const hasStructuredUndiciFailure = candidates.some(({ code }) =>
    code.startsWith('UND_ERR_'),
  );
  const transportFailure = candidates.some(({ code, name, message }) => {
    if (
      TRANSPORT_ERROR_CODES.has(code) ||
      (code === 'UND_ERR_INFO' && /\b(?:stream )?timeout\b/i.test(message))
    ) {
      return true;
    }
    return (
      !hasStructuredUndiciFailure &&
      (/(?:Connection|Timeout)Error$/.test(name) ||
        /^(?:fetch failed|failed to fetch)$/i.test(message.trim()))
    );
  });
  const statusCode = chain
    .map((current) => detectStatusCode(current))
    .find((status) => status !== undefined);
  const sharedAuthenticationFailure =
    credentialRoute === 'relay' && statusCode === 401;
  if (
    !sharedAuthenticationFailure &&
    statusCode !== 408 &&
    statusCode !== 429 &&
    (statusCode == null || statusCode < 500) &&
    !transportFailure
  ) {
    return undefined;
  }

  for (const current of chain) {
    const headers = (current as { headers?: unknown }).headers;
    if (!isObject(headers)) continue;
    const get = Reflect.get(headers, 'get');
    const read = (name: string): unknown =>
      typeof get === 'function'
        ? Reflect.apply(get, headers, [name])
        : Reflect.get(headers, name);
    const rawExplicitMs = read('retry-after-ms');
    if (rawExplicitMs != null) {
      const explicitMs = Number(rawExplicitMs);
      if (Number.isFinite(explicitMs) && explicitMs >= 0) {
        return { retryAfterMs: explicitMs };
      }
    }

    const retryAfter = read('retry-after');
    if (typeof retryAfter !== 'string') continue;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { retryAfterMs: seconds * 1000 };
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return { retryAfterMs: Math.max(0, date - Date.now()) };
    }
  }
  return { retryAfterMs: undefined };
}

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
 * Only the services this node and its `RetryableInvocationNode` base class
 * actually read: the model handler, logger, setting (temperature/tools),
 * config (for `saveCycleDebug`'s log context), the retry machinery's abort
 * controller setter, plus the live model client. Picking
 * from `AgentCore`/`BaseFlowContextInit` instead of requiring the literal
 * type keeps every existing caller, which passes the full services bag,
 * satisfying this narrower shape structurally.
 */
type InvocationServices = Pick<
  AgentCore,
  'modelHandler' | 'logger' | 'setting' | 'config'
> &
  Pick<BaseFlowContextInit, 'setAbortController'> & {
    readonly client: unknown;
    readonly clientCredentialRoute?: ModelCredentialRoute;
    readonly refreshClient?: (
      selection?: ModelCredentialSelection,
      signal?: AbortSignal,
    ) => Promise<void>;
  };

export class ModelInvocationNode<
  TShared extends BaseCycleFields,
  TServices extends InvocationServices = InvocationServices,
> extends RetryableInvocationNode<TShared, TServices> {
  private readonly _config: ModelInvocationConfig<TShared, TServices>;

  constructor(config: ModelInvocationConfig<TShared, TServices>) {
    super();
    this._config = config;
  }

  // Required by abstract base class RetryableInvocationNode
  protected getOperationName(): string {
    return this._config.operationName;
  }

  protected override isBackgroundModeActive(): boolean {
    return (
      this._config.backgroundModeAware === true &&
      this.services.modelHandler.isBackgroundModeActive()
    );
  }

  async prep(shared: TShared): Promise<BaseInvocationPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      messages: shared.messages,
      systemPrompt: this._config.getSystemPrompt?.(shared, this.services),
      finalTool: this._config.getFinalTool?.(shared, this.services),
    };
  }

  async exec(
    prepRes: BaseInvocationPrepResult,
  ): Promise<InvocationResult<BaseInvocationSuccessData>> {
    if (prepRes.shouldStop) {
      return { kind: 'skipped' };
    }

    const services = this.services;
    services.modelHandler.setOutputStreaming(this._config.streaming);

    return this.withAbortController(async (signal) => {
      const route = JSON.stringify([
        services.modelHandler.config.provider,
        services.clientCredentialRoute ?? 'configured',
        services.modelHandler.getRetryEndpoint(services.client),
      ]);
      return useLaunchRunContext().runScope.session.modelRetries.run(
        route,
        {
          signal,
          baseBackoffMs: this._retryBackoffMs,
          // Route state and node retry eligibility answer different questions.
          // Shared authentication failures must keep peers behind the gate while
          // the relay refreshes, even though pRetry must not repeat a stale
          // credential without that recovery step.
          classifyFailure: (error) =>
            classifyModelRouteFailure(error, services.clientCredentialRoute),
          recoverFailure: (error, retry) =>
            this.getRelay401Recovery(error, () => retry(), signal),
          onAdmitted:
            services.clientCredentialRoute === 'relay'
              ? () => services.refreshClient?.(undefined, signal)
              : undefined,
          onWait: (delayMs) =>
            services.logger.debug(
              `Waiting ${delayMs}ms for the shared model recovery probe.`,
            ),
        },
        async () => {
          const start = Date.now();
          const result = await services.modelHandler.createResponse({
            client: services.client,
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
        },
      );
    });
  }

  async execFallback(
    _prepRes: BaseInvocationPrepResult,
    error: Error,
  ): Promise<InvocationResult<BaseInvocationSuccessData>> {
    return this.getFallbackResult(error);
  }

  async post(
    shared: TShared,
    _prepRes: BaseInvocationPrepResult,
    execRes: InvocationResult<BaseInvocationSuccessData>,
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
            await this.services.modelHandler.createUserFollowUpMessages(
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

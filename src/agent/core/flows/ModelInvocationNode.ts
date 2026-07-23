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
import {
  classifyModelRateLimitFailure,
  classifyRelayRequestLimitFailure,
  classifyWireRouteFailure,
  isModelRateLimitFailure,
  isRelayProviderUnobservedFailure,
  isRelayRequestGateReachableFailure,
  isRelayRequestGateUnobservedFailure,
} from '@common/errors/sdkErrorUtils';
import type { ToolDefinition } from '@model';

import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';

const RELAY_USER_REQUEST_GATE_ROUTE = 'relay:user-request-gate';

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
      const wireRoute = services.modelHandler.getWireRouteKey(services.client);
      const modelRetryRoute = services.modelHandler.getModelRetryRouteKey(
        services.client,
      );
      const gate = useLaunchRunContext().runScope.session.modelRetries;
      const usesRelay = services.clientCredentialRoute === 'relay';
      const invoke = async () => {
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
      };

      return gate.run(
        wireRoute,
        {
          signal,
          baseBackoffMs: this._retryBackoffMs,
          // One wire route owns transport and server-failure cooling. A second
          // ordered scope keeps model-specific limits from blocking healthy
          // sibling models on the same credential and endpoint. Relay calls
          // also share the server's cross-provider per-user request gate.
          classifyFailure: classifyWireRouteFailure,
          isReachableFailure: isModelRateLimitFailure,
          isUnobservedFailure: isRelayProviderUnobservedFailure,
          additionalRoutes: [
            {
              key: modelRetryRoute,
              classifyFailure: classifyModelRateLimitFailure,
              isUnobservedFailure: isRelayProviderUnobservedFailure,
            },
          ],
          trailingRoutes: usesRelay
            ? [
                {
                  key: RELAY_USER_REQUEST_GATE_ROUTE,
                  classifyFailure: classifyRelayRequestLimitFailure,
                  isReachableFailure: isRelayRequestGateReachableFailure,
                  isUnobservedFailure: isRelayRequestGateUnobservedFailure,
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

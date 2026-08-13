import {
  type BaseInvocationPrepResult,
  type BaseInvocationSuccessData,
  type BaseCycleFields,
  type CycleDebugFileOptions,
  replaceMessagesInPlace,
  saveCycleDebug,
} from '@agent/core/flows/CommonCycleTypes';
import type { AgentCore } from '@agent/core/flows/BaseFlowServices';
import type { FinalTool } from '@agent/types/ModelHandlerContracts';
import {
  classifyModelRateLimitFailure,
  classifyRelayRequestLimitFailure,
  classifyWireRouteFailure,
  isModelRateLimitFailure,
  isRelayProviderUnobservedFailure,
  isRelayRequestGateReachableFailure,
  isRelayRequestGateUnobservedFailure,
} from '@common/errors/sdkError/providerErrorFormat';
import type { ToolDefinition } from '@model/ToolDefinition';

import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  RETRY_BACKOFF_MS,
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
 * actually read: the model cell (handler and live provider client), logger,
 * setting (temperature/tools), config (for `saveCycleDebug`'s log context),
 * and the run scope (retry gate, abort signal, and debug-log identity).
 */
type InvocationServices = Pick<
  AgentCore,
  'modelCell' | 'logger' | 'setting' | 'config' | 'runScope'
>;

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

  protected override isSuccessfulInvocationResult(result: unknown): boolean {
    const invocationResult =
      result as InvocationResult<BaseInvocationSuccessData>;
    return (
      invocationResult.kind === 'success' && Boolean(invocationResult.response)
    );
  }

  protected override isBackgroundModeActive(): boolean {
    return (
      this._config.backgroundModeAware === true &&
      this.services.modelCell.handler.isBackgroundModeActive()
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

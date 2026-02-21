import type { NonIterableObject } from '@agent/node';
import {
  type BaseInvocationPrepResult,
  type BaseInvocationSuccessData,
  type BaseCycleFields,
  getDebugContext,
  replaceMessagesInPlace,
} from '@agent/core/flows/CommonCycleTypes';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import type { ToolDefinition } from '@model';

import { FlowTransition } from './FlowTransitions';
import {
  type InvocationResult,
  RetryableInvocationNode,
  handleInvocationResult,
} from './RetryState';

export interface ModelInvocationConfig<TShared, TServices> {
  operationName: string;
  streaming: boolean;
  backgroundModeAware?: boolean;
  getSystemPrompt?: (shared: TShared) => string | undefined;
  getEndTag?: (services: TServices) => string | undefined;
  getTools?: (services: TServices) => ToolDefinition[] | undefined;
  storeResponse: (shared: TShared, response: unknown) => void;
  getDebugSaveOptions?: (
    shared: TShared,
    services: TServices,
  ) => {
    context: { modelName?: string; isRemote?: boolean };
    fileOptions: {
      continuationCount: number;
      baseName: string;
      outputFile?: string;
    };
  };
}

type InvocationServices = BaseFlowContextInit<any> & {
  readonly client: unknown;
  readonly refreshClient?: () => Promise<void>;
};

export class ModelInvocationNode<
  TShared extends BaseCycleFields,
  TParams extends NonIterableObject = NonIterableObject,
  TServices extends InvocationServices = InvocationServices,
> extends RetryableInvocationNode<TShared, TParams, TServices> {
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
      systemPrompt: this._config.getSystemPrompt?.(shared),
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

    const start = Date.now();

    return this.withAbortController(async (signal) => {
      const result = await services.modelHandler.createResponse({
        client: services.client,
        messages: prepRes.messages,
        temperature: services.setting.temperature,
        systemPrompt: prepRes.systemPrompt,
        endTag: this._config.getEndTag?.(services),
        signal,
        tools: this._config.getTools?.(services) ?? services.setting.tools,
      });

      return {
        kind: 'success',
        response: result.response,
        responseTimeMs: Date.now() - start,
        updatedMessages: result.updatedMessages,
      };
    });
  }

  async execFallback(
    _prepRes: BaseInvocationPrepResult,
    classified: unknown,
  ): Promise<InvocationResult<BaseInvocationSuccessData>> {
    return this.getFallbackResult(classified);
  }

  async post(
    shared: TShared,
    _prepRes: BaseInvocationPrepResult,
    execRes: InvocationResult<BaseInvocationSuccessData>,
  ): Promise<string | undefined> {
    const successRes = handleInvocationResult(execRes, shared, shared, {
      logger: this.services.logger,
      operationName: this._config.operationName,
    });

    if (!successRes) {
      return FlowTransition.COMPLETE;
    }

    if (successRes.updatedMessages !== undefined) {
      replaceMessagesInPlace(shared.messages, successRes.updatedMessages);
    }

    shared.responseTimeMs = successRes.responseTimeMs;
    this._config.storeResponse(shared, successRes.response);

    if (this._config.getDebugSaveOptions) {
      const { context, fileOptions } = this._config.getDebugSaveOptions(
        shared,
        this.services,
      );
      await maybeSaveDebugObject({
        object: successRes.response,
        objectType: 'response',
        context: getDebugContext(this.services, context),
        fileOptions,
      });
    }

    return FlowTransition.DEFAULT;
  }
}

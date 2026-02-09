import type { NonIterableObject } from '@agent/node';
import type { AgentSetting } from '@agent/core/AgentDataclass';
import {
  type BaseInvocationPrepResult,
  type BaseInvocationSuccessData,
  type BaseCycleFields,
  getDebugContext,
  replaceMessagesInPlace,
} from '@agent/core/flows/CommonCycleTypes';
import type { IModelHandler } from '@agent/modelHandlers/types/IModelHandler';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import type { AgentLogger } from '@logger/AgentLogger';
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
  getSystemPrompt?: (shared: TShared) => string | undefined;
  getEndTag?: (services: TServices) => string | undefined;
  getTools?: (services: TServices) => ToolDefinition[] | undefined;
  storeResponse: (
    shared: TShared,
    response: unknown,
    responseTimeMs: number | undefined,
  ) => void;
  isBackgroundModeActive?: (services: TServices) => boolean;
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

export interface ModelInvocationServices {
  readonly modelHandler: IModelHandler<any, any, any, any, any>;
  readonly client: unknown;
  readonly setting: AgentSetting;
  readonly logger: AgentLogger;
  readonly streamId: string;
  readonly executionId: string;
  readonly setAbortController: (ctrl: AbortController | null) => void;
  readonly refreshClient?: () => Promise<void>;
}

interface ModelInvocationPrepResult extends BaseInvocationPrepResult {
  systemPrompt?: string;
}

export class ModelInvocationNode<
  TShared extends BaseCycleFields,
  TParams extends NonIterableObject = NonIterableObject,
  TServices extends ModelInvocationServices = ModelInvocationServices,
> extends RetryableInvocationNode<TShared, TParams, TServices> {
  private readonly _config: ModelInvocationConfig<TShared, TServices>;

  constructor(config: ModelInvocationConfig<TShared, TServices>) {
    super();
    this._config = config;
  }

  protected getOperationName(): string {
    return this._config.operationName;
  }

  protected override isBackgroundModeActive(): boolean {
    return this._config.isBackgroundModeActive?.(this.services) ?? false;
  }

  async prep(shared: TShared): Promise<ModelInvocationPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      messages: shared.messages,
      systemPrompt: this._config.getSystemPrompt?.(shared),
    };
  }

  async exec(
    prepRes: ModelInvocationPrepResult,
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
        tools: this._config.getTools
          ? this._config.getTools(services)
          : services.setting.tools,
      });

      const responseTimeMs = Date.now() - start;

      return {
        kind: 'success',
        response: result.response,
        responseTimeMs,
        updatedMessages: result.updatedMessages,
      };
    });
  }

  async execFallback(
    _prepRes: ModelInvocationPrepResult,
    error: Error,
  ): Promise<InvocationResult<BaseInvocationSuccessData>> {
    return this.getFallbackResult(error);
  }

  async post(
    shared: TShared,
    _prepRes: ModelInvocationPrepResult,
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

    this._config.storeResponse(
      shared,
      successRes.response,
      successRes.responseTimeMs,
    );

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

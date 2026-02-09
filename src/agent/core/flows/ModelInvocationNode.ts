/**
 * Unified model invocation node for both response and tool-use cycles.
 *
 * Parameterized by a config object that controls streaming mode, system prompt
 * extraction, end tag extraction, response storage, and debug save behavior.
 *
 * Replaces the near-identical ResponseModelInvocationNode and ToolUseCallNode.
 */

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for a ModelInvocationNode instance. */
export interface ModelInvocationConfig<TShared, TServices> {
  /** Operation name for logs and retry prompts (e.g., 'Model invocation', 'Tool-use call'). */
  operationName: string;

  /** Whether to enable output streaming on the model handler. */
  streaming: boolean;

  /** Extract system prompt from shared state. Omit for no system prompt. */
  getSystemPrompt?: (shared: TShared) => string | undefined;

  /** Extract end tag from services. Omit for no end tag. */
  getEndTag?: (services: TServices) => string | undefined;

  /** Get tools to pass to createResponse. Defaults to `services.setting.tools`. */
  getTools?: (services: TServices) => ToolDefinition[] | undefined;

  /** Store the model response and timing on shared state. */
  storeResponse: (
    shared: TShared,
    response: unknown,
    responseTimeMs: number | undefined,
  ) => void;

  /** Check if background mode is active (enables minimum retry count). Defaults to false. */
  isBackgroundModeActive?: (services: TServices) => boolean;

  /**
   * Get debug save options for maybeSaveDebugObject in post().
   * Omit to skip debug save entirely.
   */
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

// ---------------------------------------------------------------------------
// Minimum service constraint
// ---------------------------------------------------------------------------

/** Minimum services required by ModelInvocationNode's own implementation. */
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

// ---------------------------------------------------------------------------
// Prep result
// ---------------------------------------------------------------------------

/** Data extracted by prep() for model invocation. */
interface ModelInvocationPrepResult extends BaseInvocationPrepResult {
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/**
 * Unified model invocation node with retry support.
 *
 * Handles both response-cycle and tool-use-cycle invocations via config:
 * - Response cycle: streaming=false, passes systemPrompt + endTag
 * - Tool-use cycle: streaming=true, no systemPrompt/endTag
 *
 * Extends RetryableInvocationNode for shared retry logic:
 * - maxRetries and wait configured from user settings
 * - exec() throws on error, Node retries automatically
 * - retryPrompt() shows UI when auto-retries exhausted (if error is retryable)
 * - execFallback() called only when user cancels or error is non-retryable
 *
 * Flow transitions:
 * - default: Continue to next node on success
 * - COMPLETE: All retries exhausted, non-retryable error, or user cancelled
 */
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

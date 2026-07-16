// Third-party imports

// Local imports - agent
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';

// Local imports - tools and utils
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import replacementEngine from '@replacement/engine';
import type { FileLocation, MediaAttachmentKind } from '@shared/schemas';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';

// Local imports - model handlers
import { ModelHandler } from './ModelHandler';
import type { ModelConfig } from 'llm-zoo';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CompletionUsage } from 'openai/resources/completions';

interface ValidationResponse {
  text: string;
  usage: CompletionUsage;
  stopReason: ProviderStopReason;
}

const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model handler.
`;

/**
 * Internal model handler used only by the CLI packaged-runtime validation gate.
 *
 * This handler is intentionally below `executeAgent()`: the CLI still parses
 * arguments, initializes the platform, calls the real shared runtime, and lets
 * the workflow flow write and extract output files. It is not a user-visible
 * model provider and must only be enabled by the package validation script.
 */
export class ModelHandlerValidation extends ModelHandler<
  ChatCompletionMessageParam,
  ValidationResponse['usage'],
  SdkToolCall,
  unknown,
  ValidationResponse
> {
  constructor(config: ModelConfig) {
    super(config);
    this.capabilities.supportsVision = false;
    this.capabilities.supportsFunctionCalling = false;
    this.capabilities.supportsAssistantPrefill = false;
  }

  async getClient(): Promise<unknown> {
    return {};
  }

  async createResponse(
    _options: CreateResponseOptions<ChatCompletionMessageParam, unknown>,
  ): Promise<
    CreateResponseResult<ValidationResponse, ChatCompletionMessageParam>
  > {
    return {
      response: {
        text: `<documents><document name="paper.polished.tex">${VALIDATION_OUTPUT}</document></documents>`,
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
        stopReason: 'STOP',
      },
    };
  }

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [{ role: 'user', content: `${userPrefix}\n\n${userRequest}` }];
  }

  async createRoundMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [...messages, { role: 'user', content: userMessage }];
  }

  createMediaContent(_mediaMessage: MediaEntry[]): unknown[] {
    return [];
  }

  extractResponse(responseObject: ValidationResponse): ExtractResponseResult {
    // Apply text cleanup here like every other handler's extractResponse. The
    // response cycle relies on this single per-handler pass (it no longer
    // re-applies cleanup itself), so a handler that returned raw text would
    // silently skip cleanup on the reflection path.
    return {
      text: replacementEngine.applyAll(responseObject.text),
      usage: responseObject.usage,
      stopReason: responseObject.stopReason,
    };
  }

  protected appendUserText(
    messages: ChatCompletionMessageParam[],
    text: string,
    _placement: 'last-user' | 'continuation',
  ): void {
    messages.push({ role: 'user', content: text });
  }

  protected appendTextToLastAssistantMessage(
    _messages: ChatCompletionMessageParam[],
    _text: string,
    _options?: { afterContinuationPrompt?: boolean; fallbackText?: string },
  ): boolean {
    return false;
  }

  addContinueMessage(
    _messages: ChatCompletionMessageParam[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {
    // The validation model always produces a complete response.
  }

  async initializeOutputAndPrefill(
    _agentConfig: AgentConfig,
    _agentSetting: AgentSetting,
    messages: ChatCompletionMessageParam[],
    _workspaceState: AgentWorkspaceState,
    _outputLocation: FileLocation,
    _prefill: string,
  ): Promise<[boolean, ChatCompletionMessageParam[]]> {
    return [false, messages];
  }

  computePrice(_responseUsage: ValidationResponse['usage']): number {
    return 0;
  }

  normalizeUsage(
    rawUsage: ValidationResponse['usage'],
    responseTimeMs: number,
  ): NormalizedUsage {
    return {
      inputTokens: rawUsage.prompt_tokens,
      outputTokens: rawUsage.completion_tokens,
      cost: 0,
      responseTimeMs,
      provider: 'unknown',
    };
  }

  updateMessageContent(
    messages: ChatCompletionMessageParam[],
    _bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    messages.push(this.createAssistantMessage(newResponse));
  }

  shouldContinue(
    _stopReason: ProviderStopReason,
    _newResponse: string,
    _agentSetting: AgentSetting,
  ): boolean {
    return false;
  }

  processThinkingBlock(
    _responseObject: ValidationResponse,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  extractToolUse(_responseObject: ValidationResponse): SdkToolCall[] {
    return [];
  }

  async createToolUseFollowUpMessages(
    _client: unknown,
    _call: SdkToolCall,
    result: ToolResult,
    _attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [
      {
        role: 'tool',
        tool_call_id: 'validation-tool-call',
        content: text
          ? `${text}\n${JSON.stringify(result)}`
          : JSON.stringify(result),
      },
    ];
  }

  async createUserFollowUpMessages(
    messages: ChatCompletionMessageParam[],
    userMessage: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [...messages, { role: 'user', content: userMessage }];
  }

  createAssistantMessage(text: string): ChatCompletionMessageParam {
    return { role: 'assistant', content: text };
  }

  prependTextToUserMessage(
    messages: ChatCompletionMessageParam[],
    text: string,
  ): void {
    const last = messages.at(-1);
    if (!last || last.role !== 'user' || typeof last.content !== 'string') {
      messages.push({ role: 'user', content: text });
      return;
    }
    last.content = `${text}\n${last.content}`;
  }

  async addMediaToUserMessage(
    _messages: ChatCompletionMessageParam[],
    _mediaFiles: FileLocation[],
  ): Promise<MediaAttachmentKind[]> {
    // The validation model is text-only.
    return [];
  }
}

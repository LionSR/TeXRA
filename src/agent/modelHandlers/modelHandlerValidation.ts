// Local imports - agent
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { MediaEntry } from '@agent/types/mediaTypes';

// Local imports - tools and utils
import type {
  CreateResponseOptions,
  CreateResponseResult,
  ExtractResponseResult,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import {
  mathematicalValidationOutput,
  VALIDATION_OUTPUT,
  WORKFLOW_SCRIPT_VALIDATION_SOURCE,
} from '@agent/runtime/run/validationModel';
import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import type {
  FileLocation,
  MediaAttachmentKind,
  NormalizedUsage,
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas';

// Local imports - model handlers
import { ModelHandler, type AssistantTextAppendOptions } from './ModelHandler';

// Third-party imports
import type { ModelConfig } from 'llm-zoo';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CompletionUsage } from 'openai/resources/completions';

interface ValidationResponse {
  text: string;
  usage: CompletionUsage;
  stopReason: ProviderStopReason;
  toolCalls?: SdkToolCall[];
}

function validationToolCall(name: string, input: unknown): SdkToolCall {
  const callId = `validation-${name}`;
  const argumentsJson = JSON.stringify(input);
  return {
    provider: 'openai',
    callId,
    name,
    input: argumentsJson,
    raw: {
      id: callId,
      type: 'function',
      function: { name, arguments: argumentsJson },
    },
  };
}

export class ModelHandlerValidation extends ModelHandler<
  ChatCompletionMessageParam,
  ValidationResponse['usage'],
  SdkToolCall,
  unknown,
  ValidationResponse
> {
  constructor(
    config: ModelConfig,
    responseTextProcessing?: ResponseTextProcessing,
  ) {
    super(config, responseTextProcessing);
    this.capabilities.supportsVision = false;
    this.capabilities.supportsFunctionCalling = true;
    this.capabilities.supportsAssistantPrefill = false;
  }

  async getClient(): Promise<unknown> {
    return {};
  }

  override async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, unknown>,
  ): Promise<
    CreateResponseResult<ValidationResponse, ChatCompletionMessageParam>
  > {
    let toolCalls: SdkToolCall[] | undefined;
    if (process.env.TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT === '1') {
      const toolNames = new Set(options.tools?.map((tool) => tool.name));
      const hasToolResult = options.messages.some(
        (message) => message.role === 'tool',
      );
      if (toolNames.has('submit_output')) {
        toolCalls = [
          validationToolCall(
            'submit_output',
            mathematicalValidationOutput(JSON.stringify(options.messages)),
          ),
        ];
      } else if (!hasToolResult && toolNames.has('delegate_multi_agents')) {
        toolCalls = [
          validationToolCall('delegate_multi_agents', {
            agent: 'correct',
            script: WORKFLOW_SCRIPT_VALIDATION_SOURCE,
          }),
        ];
      }
    }
    return {
      response: {
        text: toolCalls
          ? ''
          : `<documents><document name="paper.polished.tex">${VALIDATION_OUTPUT}</document></documents>`,
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
        stopReason: toolCalls ? 'tool_calls' : 'STOP',
        ...(toolCalls && { toolCalls }),
      },
    };
  }

  async initializeMessages(
    userPrefix: string,
    userRequest: string,
  ): Promise<ChatCompletionMessageParam[]> {
    return [{ role: 'user', content: `${userPrefix}\n\n${userRequest}` }];
  }

  override createMediaContent(_mediaMessage: MediaEntry[]): unknown[] {
    return [];
  }

  extractResponse(responseObject: ValidationResponse): ExtractResponseResult {
    return {
      text: this.postProcessResponse(responseObject.text),
      usage: responseObject.usage,
      stopReason: responseObject.stopReason,
    };
  }

  protected appendTextToLastAssistantMessage(
    _messages: ChatCompletionMessageParam[],
    _text: string,
    _options?: AssistantTextAppendOptions,
  ): boolean {
    return false;
  }

  override updateMessageContent(
    messages: ChatCompletionMessageParam[],
    _bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    messages.push(this.createAssistantMessage(newResponse));
  }

  processThinkingBlock(
    _responseObject: ValidationResponse,
    _workspaceState?: AgentWorkspaceState,
  ): string | null {
    return null;
  }

  createAssistantMessage(text: string): ChatCompletionMessageParam {
    return { role: 'assistant', content: text };
  }
}

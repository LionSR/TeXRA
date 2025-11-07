// Standard library imports
// (none needed)

// Third-party imports
import type OpenAI from 'openai';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';

// Third-party imports - openrouter models
import type { ChatGenerationParams } from '@openrouter/sdk/models/chatgenerationparams';
import type { ChatResponse } from '@openrouter/sdk/models/chatresponse';
import type { ChatStreamingResponseChunkData } from '@openrouter/sdk/models/chatstreamingresponsechunk';

// Local imports - agent
import { AgentWorkspaceState } from '../core/AgentWorkspaceState';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenRouterTools } from './toolConversion';
import {
  convertChatResponseToOpenAI,
  convertToOpenRouterMessages,
  createStreamAccumulator,
  consumeStreamChunk,
  finalizeStreamAccumulator,
} from './utils/openRouterConversion';
import {
  createOpenRouterClient,
  type OpenRouterClient,
} from './support/openRouterClient';
import type { ToolDefinition } from '@model';
import { K_SLICE } from '@utils/config';

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  private openRouterClient?: OpenRouterClient;

  override async getClient(): Promise<OpenAI> {
    if (!this.openRouterClient) {
      const baseURL = this.getBaseUrl();
      this.openRouterClient = await createOpenRouterClient({
        serverURL: baseURL,
        debugLogger: (message) => this.logger.debug(`[openrouter] ${message}`),
      });
    }

    return this.openRouterClient as unknown as OpenAI;
  }

  /** Creates a response using OpenRouter's API with model-specific configuration. */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<any> {
    const openRouterClient = client as unknown as OpenRouterClient;
    const useStreaming = this.getStreamingConfig();

    const routerMessages = convertToOpenRouterMessages(messages);
    const params: ChatGenerationParams = {
      messages: routerMessages,
      model: this.config.openrouterFullName ?? this.config.fullName,
    };

    if (this.isOReasoningModel) {
      params.maxCompletionTokens = this.config.maxOutputTokens;
    } else {
      params.maxTokens = this.config.maxOutputTokens;
    }

    if (!this.isOReasoningModel && !this.isGrokReasoningModel) {
      params.temperature = temperature;
    }

    if (this.config.capabilities.supportsReasoning) {
      if (
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort
      ) {
        params.reasoning = {
          effort: this.validateReasoningEffort(
            this.config.capabilities.reasoningEffort,
          ),
        } as ChatGenerationParams['reasoning'];
      }
    }

    if (tools && tools.length > 0) {
      params.tools = toOpenRouterTools(tools);
      params.toolChoice = 'auto' as ChatGenerationParams['toolChoice'];
    }

    if (endTag) {
      params.stop = [endTag];
    }

    const serverURL = this.getBaseUrl();
    const requestOptions: RequestOptions = {
      signal,
      headers: {
        'X-Title': 'TeXRA.ai',
      },
    };

    if (serverURL) {
      requestOptions.serverURL = serverURL;
    }

    if (useStreaming) {
      const streamingParams: ChatGenerationParams & {
        stream: true;
      } = {
        ...params,
        stream: true,
        streamOptions: { includeUsage: true },
      };

      const stream = (await openRouterClient.chat.send(
        streamingParams,
        requestOptions,
      )) as unknown as AsyncIterable<ChatStreamingResponseChunkData>;

      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;
      const accumulator = createStreamAccumulator();

      for await (const chunk of stream) {
        const { contentDelta, reasoningDelta } = consumeStreamChunk(
          accumulator,
          chunk,
        );
        if (reasoningDelta) {
          thinking.append(reasoningDelta);
        }
        if (contentDelta) {
          output?.append(contentDelta);
        }
      }

      const chatResponse = finalizeStreamAccumulator(
        accumulator,
        params.model ?? this.config.openrouterFullName ?? this.config.fullName,
      );
      const response = convertChatResponseToOpenAI(chatResponse);
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);

      const finalMessage = response.choices?.[0]?.message;
      const finalOutput =
        typeof finalMessage?.content === 'string'
          ? finalMessage.content
          : Array.isArray(finalMessage?.content)
            ? finalMessage.content
                .map((part: Record<string, unknown>) => {
                  if (typeof part?.text === 'string') {
                    return part.text;
                  }
                  return '';
                })
                .join('')
            : '';
      if (output) {
        output.finalize(finalOutput);
      }

      return response;
    }

    const chatResponse = (await openRouterClient.chat.send(
      params,
      requestOptions,
    )) as ChatResponse;
    return convertChatResponseToOpenAI(chatResponse);
  }

  // Implementation for processing thinking blocks in OpenRouter responses
  processThinkingBlock(
    responseObject: any,
    toolState?: AgentWorkspaceState,
  ): string | null {
    if (!responseObject) {
      return null;
    }

    // According to OpenRouter docs, reasoning is available at choices[0].message.reasoning
    if (
      responseObject.choices &&
      responseObject.choices.length > 0 &&
      responseObject.choices[0].message &&
      responseObject.choices[0].message.reasoning
    ) {
      const reasoning = responseObject.choices[0].message.reasoning;
      this.logger.debug(`OpenRouter reasoning found`);

      // Log preview of reasoning content
      if (typeof reasoning === 'string') {
        this.logger.debug(
          `Reasoning preview: ${reasoning.substring(0, K_SLICE)}...`,
        );
        return reasoning;
      } else {
        // If reasoning is an object, convert to string
        const reasoningStr = JSON.stringify(reasoning);
        this.logger.debug(
          `Reasoning preview: ${reasoningStr.substring(0, K_SLICE)}...`,
        );
        return reasoningStr;
      }
    }

    return null;
  }
}

/**
 * Handler for Anthropic models using OpenAI-compatible API via OpenRouter.
 */
export class ModelHandlerAnthropicViaOpenRouter extends ModelHandlerOpenRouter {
  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    // although OpenAI models do not support assistant prefill, some models (such as Anthropic/DeepSeek perhaps?) via OpenRouter might do
    if (lastMessage.role === 'assistant') {
      if (Array.isArray(lastMessage.content)) {
        // is this correct? it looks like we should attach previous response too.
        lastMessage.content.at(-1).text = bestConnector + newResponse;
      } else if (typeof lastMessage.content === 'string') {
        lastMessage.content = [
          {
            type: 'text',
            text: toolState.assembly.accumulatedOutput,
          },
        ];
      }
    }
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (lastMessage.role === 'user' || lastMessage.role === 'system') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: toolState.assembly.accumulatedOutput,
          },
        ],
      });
    }
  }
}

export class ModelHandlerDeepSeekViaOpenRouter extends ModelHandlerOpenRouter {}

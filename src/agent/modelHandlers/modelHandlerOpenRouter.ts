// Standard library imports
// (none needed)

// Third-party imports
import type OpenAI from 'openai';
import type { RequestOptions } from '@openrouter/sdk/lib/sdks';
import type { ChatGenerationParams } from '@openrouter/sdk/models/chatgenerationparams';
import type { ChatResponse } from '@openrouter/sdk/models/chatresponse';
import type { ChatStreamingResponseChunkData } from '@openrouter/sdk/models/chatstreamingresponsechunk';

// Local imports - agent
import { AgentWorkspaceState } from '../core/AgentWorkspaceState';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenRouterTools } from './toolConversion';
import {
  accumulateStreamChunk,
  convertChatResponseToOpenAI,
  convertMessagesToOpenRouter,
  createStreamState,
  finalizeStream,
  type StreamState,
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
  override async getClient(): Promise<OpenAI> {
    const baseURL = this.getBaseUrl();
    const client = await createOpenRouterClient({
      serverURL: baseURL,
      debugLogger: (message) => this.logger.debug(`[openrouter] ${message}`),
    });

    // The OpenRouter SDK exposes a different client surface than the OpenAI SDK,
    // but the base handler contract requires an OpenAI-compatible reference.
    // We only rely on the overridden createResponse implementation, so we cast
    // the client to satisfy the base signature without leaking OpenRouter types.
    return client as unknown as OpenAI;
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
    // Downcast to the concrete OpenRouter client so we can call the SDK directly.
    const openRouterClient = client as unknown as OpenRouterClient;
    const useStreaming = this.getStreamingConfig();
    const routerMessages = convertMessagesToOpenRouter(
      systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages,
    );

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
      params.tools = toOpenRouterTools(tools) as ChatGenerationParams['tools'];
      params.toolChoice = 'auto';
    }

    if (endTag) {
      params.stop = [endTag];
    }

    const requestOptions: RequestOptions = {
      signal,
      headers: {
        'X-Title': 'TeXRA.ai',
      },
    };

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
      const state: StreamState = createStreamState();

      for await (const chunk of stream) {
        if (signal?.aborted) {
          break;
        }

        const { content, reasoning } = accumulateStreamChunk(state, chunk);
        if (reasoning) {
          thinking.append(reasoning);
        }
        if (content) {
          output?.append(content);
        }
      }

      const chatResponse = finalizeStream(
        state,
        params.model ?? this.config.openrouterFullName ?? this.config.fullName,
      );
      const response = convertChatResponseToOpenAI(chatResponse);
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);

      const finalMessage = response.choices?.[0]?.message;
      const finalOutput = extractMessageText(finalMessage);
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
    const reasoning = responseObject?.choices?.[0]?.message?.reasoning;
    if (typeof reasoning !== 'string' || reasoning.length === 0) {
      return null;
    }

    if (toolState && !toolState.reasoning.thinkingAdded) {
      toolState.reasoning.thinkingBlocks = [
        { type: 'thinking', thinking: reasoning },
      ];
      toolState.reasoning.thinkingAdded = true;
    }

    this.logger.debug(
      `OpenRouter reasoning preview: ${reasoning.substring(0, K_SLICE)}...`,
    );
    return reasoning;
  }

  override updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== 'assistant') {
      super.updateMessageContentWithPrefill(
        messages,
        bestConnector,
        newResponse,
        toolState,
      );
      return;
    }

    const updatedText =
      toolState.assembly?.accumulatedOutput ?? `${bestConnector}${newResponse}`;

    if (Array.isArray(lastMessage.content)) {
      if (lastMessage.content.length === 0) {
        lastMessage.content = [{ type: 'text', text: updatedText }];
        return;
      }

      const lastIndex = lastMessage.content.length - 1;
      const lastPart = lastMessage.content[lastIndex];
      if (lastPart && typeof lastPart === 'object' && 'text' in lastPart) {
        lastMessage.content = [
          ...lastMessage.content.slice(0, lastIndex),
          { ...lastPart, text: updatedText },
        ];
      } else {
        lastMessage.content = [
          ...lastMessage.content,
          { type: 'text', text: updatedText },
        ];
      }
      return;
    }

    lastMessage.content = [{ type: 'text', text: updatedText }];
  }

  override updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);
    const fallbackText =
      toolState.assembly?.accumulatedOutput ?? `${bestConnector}${newResponse}`;

    if (
      !lastMessage ||
      (lastMessage.role !== 'user' && lastMessage.role !== 'system')
    ) {
      this.logger.error(
        'Last message is not a user or system message - unexpected format',
      );
      return;
    }

    if (this.containCutOffMessage(lastMessage.content)) {
      if (secondLastMessage && secondLastMessage.role === 'assistant') {
        if (Array.isArray(secondLastMessage.content)) {
          secondLastMessage.content = [
            ...secondLastMessage.content,
            { type: 'text', text: fallbackText },
          ];
        } else {
          this.logger.error('Second last message content is not a list');
          secondLastMessage.content = [{ type: 'text', text: fallbackText }];
        }

        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        } else {
          this.logger.error(
            'Last message is not a user message - unexpected format',
          );
        }
      }
      return;
    }

    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: fallbackText }],
    });
  }
}

export class ModelHandlerDeepSeekViaOpenRouter extends ModelHandlerOpenRouter {}

function extractMessageText(message: any): string {
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .map((part: any) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

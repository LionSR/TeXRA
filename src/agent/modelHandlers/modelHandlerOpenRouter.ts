// Third-party imports
import OpenAI from 'openai';
import { isAssistantMessage } from 'openai/lib/chatCompletionUtils';

// Local imports - agent
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

// Local file imports
import {
  ModelHandlerOpenAI,
  extractReasoningDelta,
} from './modelHandlerOpenAI';
import { toOpenAITools } from './toolConversion';
import { executeRequest } from './utils/requestExecutor';
import type { CreateResponseOptions } from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  /** Creates a response using OpenRouter's API with model-specific configuration. */
  async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<ChatCompletion> {
    const { client, messages, temperature, endTag, signal, tools } = options;
    // Get streaming config
    const useStreaming = this.getStreamingConfig();

    const kwargs: any = {
      model: this.config.openrouterFullName, // Use OpenRouter model name
      messages,
      max_tokens: this.config.maxOutputTokens,
      temperature,
      extra_headers: { 'X-Title': 'TeXRA.ai' },
    };

    // Reasoning parameters might vary depending on the underlying model via OpenRouter
    // The `reasoning` and `include_reasoning` parameters are specific to some models like O1
    if (this.config.capabilities.supportsReasoning) {
      if (
        this.config.capabilities.supportsReasoningEffort &&
        this.config.capabilities.reasoningEffort
      ) {
        kwargs.reasoning = {
          effort: this.validateReasoningEffort(
            this.config.capabilities.reasoningEffort,
          ),
        };
        kwargs.include_reasoning = true;
      }
    }

    if (tools && tools.length > 0) {
      kwargs.tools = toOpenAITools(tools);
      kwargs.tool_choice = 'auto';
    }

    if (endTag) {
      kwargs.stop = [endTag];
    }

    if (useStreaming) {
      kwargs.stream_options = { include_usage: true }; // Assuming OpenRouter passes this through
      const stream = await executeRequest(
        {
          logger: this.logger,
          model: this.config.name,
          operation: 'openrouter.chat.completions.stream',
          signal,
        },
        () => client.chat.completions.stream(kwargs, { signal }),
      );
      const thinking = this.createThinkingStream();
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream()
        : undefined;
      for await (const chunk of stream) {
        const reasoningDelta = extractReasoningDelta(chunk);
        const contentDelta = chunk.choices[0]?.delta?.content ?? '';
        if (reasoningDelta) thinking.append(reasoningDelta);
        if (contentDelta) output?.append(contentDelta);
      }

      // Note that there is no second consumption problem
      // But i am not sure about openrouter's stream api, whether it works for every model.
      let response = await stream.finalChatCompletion();

      // Ensure usage is captured - use SDK's totalUsage() as fallback
      if (!response.usage) {
        try {
          const totalUsage = await stream.totalUsage();
          response = { ...response, usage: totalUsage };
        } catch {
          // totalUsage() may fail if stream ended abnormally
        }
      }

      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const finalOutput = response.choices?.[0]?.message?.content ?? '';
      if (output) output.finalize(finalOutput);
      return response;
    } else {
      return executeRequest(
        {
          logger: this.logger,
          model: this.config.name,
          operation: 'openrouter.chat.completions.create',
          signal,
        },
        () => client.chat.completions.create(kwargs, { signal }),
      );
    }
  }

  /**
   * OpenRouter uses 'reasoning' field instead of 'reasoning_content'.
   * Also handles object values by converting to JSON.
   */
  protected override extractReasoningFromMessage(
    message: Record<string, unknown> | undefined,
  ): string | null {
    const reasoning = message?.reasoning;
    if (!reasoning) {
      return null;
    }
    if (typeof reasoning === 'string' && reasoning.trim()) {
      return reasoning;
    }
    // If reasoning is an object, convert to string
    const reasoningStr = JSON.stringify(reasoning);
    return reasoningStr.trim() || null;
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
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    // although OpenAI models do not support assistant prefill, some models (such as Anthropic/DeepSeek perhaps?) via OpenRouter might do
    if (isAssistantMessage(lastMessage)) {
      if (Array.isArray(lastMessage.content)) {
        // is this correct? it looks like we should attach previous response too.
        const lastPart = lastMessage.content.at(-1);
        if (lastPart && 'text' in lastPart) {
          lastPart.text = bestConnector + newResponse;
        }
      } else if (typeof lastMessage.content === 'string') {
        lastMessage.content = [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ];
      }
    }
  }

  /** Updates message content for models with prefill support. */
  updateMessageContentWithoutPrefill(
    messages: any[],
    _bestConnector: string,
    _newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'user' || lastMessage?.role === 'system') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: workspaceState.assembly.accumulatedOutput,
          },
        ],
      });
    }
  }
}

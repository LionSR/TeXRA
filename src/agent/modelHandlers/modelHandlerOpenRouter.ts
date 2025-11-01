// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent
import { ToolState } from '../core/ToolState';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenAITools } from './toolConversion';
import type { ToolDefinition } from '@model';
import { K_SLICE } from '@utils/config';

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
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
      const stream = client.chat.completions.stream(kwargs, { signal });
      const groupId = this.logger.getActiveGroupId();
      const thinking = this.createThinkingStream(groupId);
      const output = this.isOutputStreamingEnabled()
        ? this.createOutputStream(groupId)
        : undefined;
      for await (const chunk of stream) {
        const reasoningDelta =
          (chunk.choices[0]?.delta as any)?.reasoning_content ?? '';
        const contentDelta = chunk.choices[0]?.delta?.content ?? '';
        if (reasoningDelta) thinking.append(reasoningDelta);
        if (contentDelta) output?.append(contentDelta);
      }

      // Note that there is no second consumption problem
      // But i am not sure about openrouter's stream api, whether it works for every model.
      const response = await stream.finalChatCompletion();
      const finalReasoning = this.processThinkingBlock(response);
      thinking.finalize(finalReasoning ?? undefined);
      const finalOutput = response.choices?.[0]?.message?.content ?? '';
      if (output) output.finalize(finalOutput);
      return response;
    } else {
      return await client.chat.completions.create(kwargs, { signal });
    }
  }

  // Implementation for processing thinking blocks in OpenRouter responses
  processThinkingBlock(
    responseObject: any,
    toolState?: ToolState,
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
    toolState: ToolState,
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
            text: toolState.accumulatedOutput,
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
    toolState: ToolState,
  ): void {
    const lastMessage = messages.at(-1);
    if (lastMessage.role === 'user' || lastMessage.role === 'system') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: toolState.accumulatedOutput,
          },
        ],
      });
    }
  }
}

export class ModelHandlerDeepSeekViaOpenRouter extends ModelHandlerOpenRouter {}

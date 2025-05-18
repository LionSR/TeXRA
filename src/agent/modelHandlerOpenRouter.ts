// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with OpenRouter settings. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using OpenRouter API key. Base URL: ${baseURL}`);
    return new OpenAI({
      apiKey,
      baseURL,
    });
  }

  /** Creates a response using OpenRouter's API with model-specific configuration. */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
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

    if (endTag) {
      kwargs.stop = [endTag];
    }

    if (useStreaming) {
      kwargs.stream_options = { include_usage: true }; // Assuming OpenRouter passes this through
      const stream = client.beta.chat.completions.stream(kwargs, { signal });
      return await stream.finalMessage();
    } else {
      return await client.chat.completions.create(kwargs, { signal });
    }
  }

  // Implementation for processing thinking blocks in OpenRouter responses
  processThinkingBlock(
    responseObject: any,
    groupId?: string,
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
      this.logger.debug(`OpenRouter reasoning found`, groupId);

      // Log preview of reasoning content
      if (typeof reasoning === 'string') {
        this.logger.debug(
          `Reasoning preview: ${reasoning.substring(0, 200)}...`,
          groupId,
        );
        return reasoning;
      } else {
        // If reasoning is an object, convert to string
        const reasoningStr = JSON.stringify(reasoning);
        this.logger.debug(
          `Reasoning preview: ${reasoningStr.substring(0, 200)}...`,
          groupId,
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
  /** Returns OpenAI client configured with OpenRouter settings for Anthropic models. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(
      `Using OpenRouter API key for Anthropic model. Base URL: ${baseURL}`,
    );
    return new OpenAI({
      apiKey,
      baseURL,
    });
  }

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

export class ModelHandlerDeepSeekViaOpenRouter extends ModelHandlerOpenRouter {
  /** Returns OpenAI client configured with OpenRouter settings for DeepSeek models. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(
      `Using OpenRouter API key for DeepSeek model. Base URL: ${baseURL}`,
    );
    return new OpenAI({
      apiKey,
      baseURL,
    });
  }
}

// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  /** Get OpenAI client with OpenRouter configuration. */
  getClient(): OpenAI {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    logger.info(
      'ModelHandlerOpenRouter',
      `Using OpenRouter API key. Base URL: ${baseUrl}`,
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
  }

  /** Create a response using OpenRouter's API. */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any> {
    const kwargs: any = {
      model: this.config.openrouterFullName, // Use OpenRouter model name
      messages,
      max_tokens: this.config.maxOutputTokens,
      temperature,
      extra_headers: { 'X-Title': 'CoA' },
    };

    if (endTag) {
      kwargs.stop = [endTag];
    }

    return client.chat.completions.create(kwargs);
  }
}

/**
 * Handler for Anthropic models using OpenAI-compatible API via OpenRouter.
 */
export class ModelHandlerAnthropicViaOpenRouter extends ModelHandlerOpenRouter {
  /** Get OpenAI client with Anthropic's base URL. */
  getClient(): OpenAI {
    return new OpenAI({
      apiKey: this.getApiKey(),
      baseURL: this.getBaseUrl(),
    });
  }

  /** Update message content for Anthropic models via OpenRouter. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    const lastMessage = messages[messages.length - 1];
    if (this.capabilities.supportsAssistantPrefill) {
      // although OpenAI models do not support assistant prefill, some models (such as Anthropic) via OpenRouter might do
      if (lastMessage.role === 'assistant') {
        if (Array.isArray(lastMessage.content)) {
          lastMessage.content[lastMessage.content.length - 1].text =
            bestConnector + newResponse;
        } else if (typeof lastMessage.content === 'string') {
          lastMessage.content = toolState.accumulatedOutput;
        }
      } else if (lastMessage.role === 'user') {
        messages.push({
          role: 'assistant',
          content: toolState.accumulatedOutput,
        });
      }
    }
  }
}

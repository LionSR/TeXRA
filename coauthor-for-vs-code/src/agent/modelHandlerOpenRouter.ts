// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';

const CHANNEL = 'Agent';
logger.initialize(CHANNEL);

/**
 * Handler for models accessed through OpenRouter.
 */
export class ModelHandlerOpenRouter extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with OpenRouter settings. */
  getClient(): OpenAI {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    logger.info(CHANNEL, `Using OpenRouter API key. Base URL: ${baseUrl}`);
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
  }

  /** Creates a response using OpenRouter's API with model-specific configuration. */
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
  /** Returns OpenAI client configured with Anthropic's base URL. */
  getClient(): OpenAI {
    return new OpenAI({
      apiKey: this.getApiKey(),
      baseURL: this.getBaseUrl(),
    });
  }

  /** Updates message content with support for Anthropic's assistant prefill. */
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

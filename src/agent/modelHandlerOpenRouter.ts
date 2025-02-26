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

  /** Updates message content with support for Anthropic's assistant prefill. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    const lastMessage = messages.at(-1);
    if (this.capabilities.supportsAssistantPrefill) {
      // although OpenAI models do not support assistant prefill, some models (such as Anthropic) via OpenRouter might do
      if (lastMessage.role === 'assistant') {
        if (Array.isArray(lastMessage.content)) {
          lastMessage.content.at(-1).text = bestConnector + newResponse;
        } else if (typeof lastMessage.content === 'string') {
          lastMessage.content = toolState.accumulatedOutput;
        }
      } else if (lastMessage.role === 'user' || lastMessage.role === 'system') {
        messages.push({
          role: 'assistant',
          content: toolState.accumulatedOutput,
        });
      }
    }
  }
}

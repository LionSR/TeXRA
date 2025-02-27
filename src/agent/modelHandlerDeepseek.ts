// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { hasEndTag } from './AgentDataclass';
import { OpenAIAPIResponseUsage, ResponseUsageFactory } from './ResponseUsage';

/**
 * Handler for Deepseek models using OpenAI-compatible API.
 * The Flash Thinking model is an experimental model and has the following limitations:
 * Thoughts are only shown in Deepseek AI Studio
 * Therefore we cannot extract them from the response yet
 */
export class ModelHandlerDeepseek extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with Deepseek's base URL. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using Deepseek API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }
}

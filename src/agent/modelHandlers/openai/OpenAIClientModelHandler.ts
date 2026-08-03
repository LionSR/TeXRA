// Third-party imports
import OpenAI from 'openai';

// Local imports
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type {
  ModelCredentialSelection,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import { ModelHandler } from '../ModelHandler';

// Local file imports
import { logOpenAICompatibleClientConfig } from './openAIChatHelpers';

/**
 * Shared client-construction surface for the OpenAI-family handlers
 * (Chat Completions and Responses API). Both bind the base `ModelHandler`'s
 * client type parameter to the OpenAI SDK client, so credential resolution,
 * client construction, and logging are identical across them — kept here
 * rather than on `ModelHandler` so non-OpenAI providers don't carry this
 * SDK dependency.
 */
export abstract class OpenAIClientModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  T extends SdkToolCall = SdkToolCall,
  Resp = unknown,
  Media = unknown,
> extends ModelHandler<M, U, T, OpenAI, Resp, Media> {
  /**
   * Creates a new OpenAI client using the stored credentials.
   * Handles API key retrieval, base URL resolution, and logging.
   */
  protected async createOpenAIClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<OpenAI> {
    const credential = await this.resolveClientCredential(selection);
    // there is a time out parameter that can be set; default is 10 minutes
    const client = new OpenAI({
      apiKey: credential.apiKey,
      baseURL: credential.baseUrl,
      fetch: this.longRunningModelFetch,
      maxRetries: 0,
    });
    logOpenAICompatibleClientConfig(
      this.logger,
      this.config,
      client.baseURL,
      credential.route,
      this.shouldUseServerSideKeys(),
    );
    return this.rememberClientCredentialRoute(
      client,
      credential.route,
      credential.apiKey,
    );
  }

  /** Returns OpenAI client with configured API key. */
  async getClient(
    selection: ModelCredentialSelection = 'configured',
  ): Promise<OpenAI> {
    return this.createOpenAIClient(selection);
  }

  override getRetryEndpoint(client: OpenAI): string {
    return client.baseURL;
  }
}

// Third-party imports
import OpenAI from 'openai';

// Local imports
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type {
  ModelCredentialSelection,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';

// Local file imports
import { logOpenAICompatibleClientConfig } from './openAIChatHelpers';

/**
 * Shared mechanics for handlers that talk to an OpenAI-compatible endpoint
 * through the `openai` SDK client. The client-construction, `getClient`, and
 * retry-endpoint contract live here so the Chat Completions
 * ({@link ModelHandlerOpenAI}) and Responses ({@link ModelHandlerOpenAIResponse})
 * handlers do not each re-implement byte-identical copies.
 *
 * Generic over the same wire types as {@link ModelHandler} (`M`/`U`/`T`/`Resp`/
 * `Media`), with the client type pinned to {@link OpenAI} — the one axis all
 * OpenAI-compatible handlers share.
 */
export abstract class OpenAICompatibleModelHandler<
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

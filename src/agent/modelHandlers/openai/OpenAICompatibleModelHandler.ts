// Third-party imports
import { ModelProvider } from 'llm-zoo';
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
  /** Runtime combinator (provider identity × reasoning capability), read by
   * multiple call sites in `openai/` — kept as a named getter rather than
   * inlined at each one (#7101 triage: DRY combinator, not per-provider
   * override). Lives on the OpenAI-compatible base rather than the
   * host-agnostic `ModelHandler` because it hard-codes an OpenAI provider
   * check and has no reader outside this subtree. */
  get isOReasoningModel(): boolean {
    return (
      this.config.provider === ModelProvider.OPENAI &&
      this.capabilities.supportsReasoning
    );
  }

  /**
   * Creates a new OpenAI client using the stored credentials.
   * Handles API key retrieval, base URL resolution, and logging.
   */
  async getClient(
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
    const registered = this.rememberClientCredentialRoute(
      client,
      credential.route,
      credential.apiKey,
    );
    return credential.usageRoute
      ? this.rememberClientUsageRoute(registered, credential.usageRoute)
      : registered;
  }

  override getRetryEndpoint(client: OpenAI): string {
    return client.baseURL;
  }

  /**
   * Stamp the resolved request endpoint onto an OpenAI-SDK error at the
   * boundary, because the SDK's `APIError` carries status/body/headers but no
   * request config. Downstream endpoint-scoped detection (Kimi Code
   * subscription usage limits) reads this stamp.
   */
  protected override attachSdkRequestEndpoint(
    err: unknown,
    client: OpenAI,
  ): void {
    const baseURL = this.getRetryEndpoint(client);
    if (!baseURL) return;
    if (typeof err !== 'object' || err === null) return;
    const candidate = err as { request?: { baseURL?: string } | null };
    if (candidate.request == null) {
      candidate.request = { baseURL };
    }
  }
}

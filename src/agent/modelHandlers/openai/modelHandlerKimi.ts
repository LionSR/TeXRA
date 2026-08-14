import { z } from 'zod';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { TokenCountOptions } from '@agent/types/ModelHandlerContracts';
import type { ToolDefinition } from '@model/ToolDefinition';
import { isKimiCodeExclusiveModel } from '@model/kimiCodeSubscriptionRouting';
import { AUXILIARY_MAX_RETRIES } from '../support/auxiliaryRetry';
import { resolveMoonshotRequestParameters } from '../support/moonshotRequestParameters';
import { ReasoningModelHandlerOpenAI } from './reasoningModelHandlerOpenAI';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type OpenAI from 'openai';

/**
 * Moonshot API `fullName`s shared by more than one TeXRA registry entry — a
 * reasoning and a non-reasoning variant of the same Kimi model family (e.g.
 * `kimi25`/`kimi25T` both wire to `kimi-k2.5`) distinguished only by TeXRA's
 * `supportsReasoning` capability. Moonshot's API can't see that distinction
 * and defaults these wire names to thinking-enabled, so the non-reasoning
 * registry entry must explicitly send `thinking: { type: 'disabled' }`.
 *
 * Computed from the live registry rather than a pinned fullName literal, so
 * a Kimi model added later that reuses this shared-fullName pattern (as
 * `kimi26`/`kimi26T` already do) is disambiguated automatically — no new
 * exact-name check to remember.
 */
const AMBIGUOUS_THINKING_DEFAULT_FULLNAMES: ReadonlySet<string> = (() => {
  const supportsReasoningByFullName = new Map<string, boolean>();
  const ambiguous = new Set<string>();
  for (const config of Object.values(MODEL_CONFIGS)) {
    if (config.provider !== ModelProvider.MOONSHOT) continue;
    const seen = supportsReasoningByFullName.get(config.fullName);
    if (seen !== undefined && seen !== config.capabilities.supportsReasoning) {
      ambiguous.add(config.fullName);
    }
    supportsReasoningByFullName.set(
      config.fullName,
      config.capabilities.supportsReasoning,
    );
  }
  return ambiguous;
})();

/** Response from Kimi's token estimation API */
const KimiTokenEstimateResponseSchema = z.object({
  data: z.object({ total_tokens: z.number() }),
});

const KIMI_TOKEN_ESTIMATE_TIMEOUT_MS = 20_000; // 20 s

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 * Kimi K2 Thinking models return reasoning_content automatically when streaming.
 *
 * Some Kimi model families share one Moonshot API fullName between a
 * reasoning and non-reasoning registry entry and default to thinking
 * enabled on the wire; see {@link AMBIGUOUS_THINKING_DEFAULT_FULLNAMES} for
 * how the non-reasoning entry gets it explicitly disabled, and
 * the shared Moonshot request rules for families requiring fixed sampling.
 *
 * Supports thinking mode with tool calls. When thinking mode is enabled:
 * - The model outputs reasoning_content along with tool_calls
 * - The reasoning_content must be included in assistant messages during tool-use cycles
 *
 * @see https://platform.moonshot.cn/docs/guide/reasoning-model
 */
export class ModelHandlerKimi extends ReasoningModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'moonshot';
  }

  /** Classify successful coding-endpoint requests as subscription usage. */
  override getLastCredentialUsageRoute(): NormalizedUsage['usageRoute'] {
    const route = super.getLastCredentialUsageRoute();
    return route === 'api-key' && isKimiCodeExclusiveModel(this.config)
      ? 'kimi-code-subscription'
      : route;
  }

  // Kimi K2.5 supports vision with standard OpenAI-style image_url format;
  // only stringify content for non-vision variants so image parts survive.
  protected override readonly convertContentToStringUnlessVision = true;

  protected override getThinkingParameter():
    { type: 'enabled' | 'disabled' } | undefined {
    // See AMBIGUOUS_THINKING_DEFAULT_FULLNAMES: these wire names default to
    // thinking-enabled on the Moonshot API, so the non-reasoning registry
    // entry must explicitly turn it off.
    if (
      AMBIGUOUS_THINKING_DEFAULT_FULLNAMES.has(this.config.fullName) &&
      !this.capabilities.supportsReasoning
    ) {
      return { type: 'disabled' };
    }
    return undefined;
  }

  protected override buildChatBaseParams(
    messages: ChatCompletionMessageParam[],
    _temperature?: number,
    systemPrompt?: string,
    endTag?: string,
    tools?: ToolDefinition[],
  ) {
    const requestParameters = resolveMoonshotRequestParameters(
      this.config.fullName,
      this.capabilities.supportsReasoning,
    );
    const temperature = requestParameters
      ? requestParameters.temperature
      : _temperature;
    const params = super.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
    if (requestParameters && temperature === undefined) {
      delete params.temperature;
    }
    return params;
  }

  protected override buildCompactionSummaryParams(
    conversationMessages: ChatCompletionMessageParam[],
    systemPrompt: string,
  ) {
    const params = super.buildCompactionSummaryParams(
      conversationMessages,
      systemPrompt,
    );
    const requestParameters = resolveMoonshotRequestParameters(
      this.config.fullName,
      this.capabilities.supportsReasoning,
    );
    if (requestParameters) {
      if (requestParameters.temperature === undefined) {
        delete params.temperature;
      } else {
        params.temperature = requestParameters.temperature;
      }
      if (requestParameters.disableThinkingInCompactionSummary) {
        delete params.thinking;
      }
    }
    return params;
  }

  /**
   * Whether this handler supports native token counting.
   * Kimi provides a token estimation API for accurate pre-flight counts.
   */
  override get supportsTokenCounting(): boolean {
    // Moonshot's native endpoint supports token estimation. Managed services
    // may expose only the configured chat endpoint, so they must opt in via
    // capabilities before this handler calls the auxiliary tokenizer route.
    return (
      !isKimiCodeExclusiveModel(this.config) ||
      this.capabilities.supportsTokenCounting
    );
  }

  /**
   * Estimates token count using Kimi's native token counting API.
   * This provides accurate token counts for Moonshot models.
   *
   * The OpenAI-compatible client owns transient retry policy (408, 409, 429,
   * 5xx, network failures, and Retry-After) and applies the timeout per
   * attempt. The owning run's signal cancels requests and retry delays.
   *
   * @param messages The messages to count tokens for.
   * @param options Cancellation signal for the owning run.
   * @returns Promise resolving to the total token count.
   * @see https://platform.moonshot.cn/docs/api/tokenization
   */
  override async estimateTokenCount(
    messages: ChatCompletionMessageParam[],
    options?: TokenCountOptions<OpenAI>,
  ): Promise<number> {
    const client = options?.client ?? (await this.getClient());
    const raw = await client.post<unknown>('/tokenizers/estimate-token-count', {
      body: { model: this.config.fullName, messages },
      maxRetries: AUXILIARY_MAX_RETRIES,
      timeout: KIMI_TOKEN_ESTIMATE_TIMEOUT_MS,
      signal: options?.signal,
    });

    const parsed = KimiTokenEstimateResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Kimi token estimation returned an unexpected response shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data.data.total_tokens;
  }
}

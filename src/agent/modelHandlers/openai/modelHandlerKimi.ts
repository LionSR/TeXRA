import { z } from 'zod';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { TokenCountOptions } from '@agent/types/ModelHandlerContracts';
import type { ToolDefinition } from '@model';
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

interface FixedTemperatureRule {
  /**
   * Resolve the temperature Moonshot requires for this model family.
   * `undefined` means the request must omit `temperature` entirely
   * (Moonshot fixes sampling server-side and documents omitting the field).
   */
  readonly temperature: (supportsReasoning: boolean) => number | undefined;
  /** Whether compaction-summary calls must also drop `thinking` entirely. */
  readonly disableThinkingInCompactionSummary?: boolean;
}

/**
 * Fixed sampling temperature required by specific Moonshot API `fullName`s.
 * Moonshot's API pins (or silently degrades) sampling for these families
 * regardless of the caller-requested temperature; fullNames not listed here
 * pass the requested temperature through unchanged. This is genuine
 * per-model API knowledge that has no equivalent llm-zoo capability flag
 * today, so it stays a small explicit table rather than a derived rule —
 * adding a new fixed-temperature model is one new entry here, not a new
 * `fullName === '...'` branch scattered through the handler body.
 */
const FIXED_TEMPERATURE_BY_FULLNAME: ReadonlyMap<string, FixedTemperatureRule> =
  new Map<string, FixedTemperatureRule>([
    [
      'kimi-k2.5',
      {
        temperature: (supportsReasoning: boolean) =>
          supportsReasoning ? 1 : 0.6,
      },
    ],
    [
      'kimi-k2.7-code',
      { temperature: () => 1, disableThinkingInCompactionSummary: true },
    ],
    // kimi-k3 fixes temperature=1.0 server-side and its docs say to omit the
    // field from requests (alongside top_p/n/penalties, which TeXRA never
    // sends to Moonshot anyway).
    [
      'kimi-k3',
      {
        temperature: () => undefined,
        disableThinkingInCompactionSummary: true,
      },
    ],
  ]);

/** Response from Kimi's token estimation API */
const KimiTokenEstimateResponseSchema = z.object({
  data: z.object({ total_tokens: z.number() }),
});

const KIMI_TOKEN_ESTIMATE_TIMEOUT_MS = 20_000; // 20 s
const KIMI_TOKEN_ESTIMATE_RETRIES = 2;

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 * Kimi K2 Thinking models return reasoning_content automatically when streaming.
 *
 * Some Kimi model families share one Moonshot API fullName between a
 * reasoning and non-reasoning registry entry and default to thinking
 * enabled on the wire; see {@link AMBIGUOUS_THINKING_DEFAULT_FULLNAMES} for
 * how the non-reasoning entry gets it explicitly disabled, and
 * {@link FIXED_TEMPERATURE_BY_FULLNAME} for families requiring a pinned
 * sampling temperature.
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

  // Kimi K2.5 supports vision with standard OpenAI-style image_url format;
  // only stringify content for non-vision variants so image parts survive.
  protected override readonly convertContentToStringUnlessVision = true;

  /**
   * Kimi K3 is the only Moonshot model with `supportsReasoningEffort` (K2.x
   * use the `thinking` parameter instead), and its `reasoning_effort` field
   * currently accepts only `'max'` — which the shared OpenAI clamp lowers to
   * `'xhigh'`, a value Moonshot rejects. Send Moonshot's own vocabulary.
   */
  protected override validateReasoningEffort(_effort: string): string {
    return 'max';
  }

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
    const fixedTemperature = FIXED_TEMPERATURE_BY_FULLNAME.get(
      this.config.fullName,
    );
    const temperature = fixedTemperature
      ? fixedTemperature.temperature(this.capabilities.supportsReasoning)
      : _temperature;
    return super.buildChatBaseParams(
      messages,
      temperature,
      systemPrompt,
      endTag,
      tools,
    );
  }

  protected override buildCompactionSummaryParams(
    conversationMessages: ChatCompletionMessageParam[],
    systemPrompt: string,
  ) {
    const params = super.buildCompactionSummaryParams(
      conversationMessages,
      systemPrompt,
    );
    const fixedTemperature = FIXED_TEMPERATURE_BY_FULLNAME.get(
      this.config.fullName,
    );
    if (fixedTemperature) {
      const temperature = fixedTemperature.temperature(
        this.capabilities.supportsReasoning,
      );
      if (temperature === undefined) {
        delete params.temperature;
      } else {
        params.temperature = temperature;
      }
      if (fixedTemperature.disableThinkingInCompactionSummary) {
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
    return true;
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
      maxRetries: KIMI_TOKEN_ESTIMATE_RETRIES,
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

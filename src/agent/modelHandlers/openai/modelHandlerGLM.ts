// Third-party imports
import { ReasoningEffort } from 'llm-zoo';

// Local imports - agent
import type { StandardPricingConfig } from '@agent/modelHandlers/support/priceUtils';
import {
  clampReasoningEffortToHighOrMax,
  normalizeSupportedReasoningEffort,
} from '@agent/modelHandlers/support/reasoningEffort';

// Local file imports
import { ReasoningModelHandlerOpenAI } from './reasoningModelHandlerOpenAI';

/**
 * Handler for GLM (Zhipu AI / Z.AI) models using OpenAI-compatible API.
 *
 * GLM models (4.5, 4.7, 5) support deep thinking via standard `reasoning_content`
 * in both streaming deltas and non-streaming responses. Thinking is controlled by
 * the `thinking` parameter: `{ type: "enabled" | "disabled" }`.
 *
 * GLM supports interleaved thinking with tool calls — the model thinks between
 * tool invocations and after receiving results. Historical `reasoning_content`
 * must be preserved in tool-use follow-up messages for reasoning coherence.
 *
 * usageProvider and toolCallProvider inherit from base class via config.provider.
 *
 * @see https://docs.z.ai/guides/capabilities/thinking
 * @see https://open.bigmodel.cn/dev/api
 */
export class ModelHandlerGLM extends ReasoningModelHandlerOpenAI {
  /** Coding-plan usage is covered by the subscription, not billed per token. */
  protected override standardPricingConfig(): StandardPricingConfig {
    return this.getLastCredentialUsageRoute() === 'glm-coding-plan-subscription'
      ? { ...super.standardPricingConfig(), inputPrice: 0, outputPrice: 0 }
      : super.standardPricingConfig();
  }

  /**
   * GLM keeps reasoning continuity without batching parallel tool results into
   * one follow-up message. See the base getter's doc comment (#7101 triage)
   * for why this can't fold into a single `supportsReasoning` read: GLM's
   * reasoning-capable variants (`glm45`, `glm52`) still don't batch.
   */
  override get requiresBatchedParallelToolResults(): boolean {
    return false;
  }

  private normalizeReasoningEffort(effort: ReasoningEffort): ReasoningEffort {
    const supported = this.capabilities.supportedReasoningEfforts;
    return supported?.length
      ? normalizeSupportedReasoningEffort(
          effort,
          supported,
          this.capabilities.reasoningEffort,
        )
      : clampReasoningEffortToHighOrMax(effort);
  }

  protected override getReasoningEffortParameter(): string | undefined {
    const effort = this.getEffectiveReasoningEffort();
    if (!this.capabilities.supportsReasoning || !effort) return undefined;

    const normalized = this.normalizeReasoningEffort(effort);
    return normalized === ReasoningEffort.NONE ? undefined : normalized;
  }

  /**
   * GLM models require explicit `thinking` parameter to control reasoning.
   * Models whose vocabulary includes none can disable it; forced-thinking
   * variants such as GLM-5.3 keep it enabled.
   */
  protected override getThinkingParameter(): { type: 'enabled' | 'disabled' } {
    if (!this.capabilities.supportsReasoning) return { type: 'disabled' };

    const supported = this.capabilities.supportedReasoningEfforts;
    if (!supported?.length) return { type: 'enabled' };

    const effort = this.getEffectiveReasoningEffort();
    const normalized = effort
      ? normalizeSupportedReasoningEffort(
          effort,
          supported,
          this.capabilities.reasoningEffort,
        )
      : this.capabilities.reasoningEffort;
    return normalized === ReasoningEffort.NONE
      ? { type: 'disabled' }
      : { type: 'enabled' };
  }

  protected override getCompactionReasoningParameters() {
    const supported = this.capabilities.supportedReasoningEfforts;
    if (supported?.length && !supported.includes(ReasoningEffort.NONE)) {
      return {
        thinking: { type: 'enabled' as const },
        reasoning_effort: this.normalizeReasoningEffort(ReasoningEffort.NONE),
      };
    }
    return super.getCompactionReasoningParameters();
  }
}

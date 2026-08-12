// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { clampReasoningEffortToHighOrMax } from '@agent/modelHandlers/support/reasoningEffort';
// Local imports - model routing
import { isGlmCodingPlanRouteActive } from '@model/codingPlanSubscriptions';

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
  /** Classify successful coding-endpoint requests as subscription usage. */
  override getLastCredentialUsageRoute(): NormalizedUsage['usageRoute'] {
    const route = super.getLastCredentialUsageRoute();
    return route === 'api-key' && isGlmCodingPlanRouteActive(this.config)
      ? 'glm-coding-plan-subscription'
      : route;
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

  /**
   * GLM effort-capable models accept only high/max on the OpenAI-compatible
   * surface; delegate to the shared high-or-max clamp (see
   * `clampReasoningEffortToHighOrMax`).
   */
  protected override validateReasoningEffort(effort: string): string {
    return clampReasoningEffortToHighOrMax(effort);
  }

  /**
   * GLM models require explicit `thinking` parameter to control reasoning.
   * Thinking models (e.g. GLM-4.5) need it enabled; non-thinking variants
   * get it explicitly disabled to prevent unexpected reasoning activation.
   */
  protected override getThinkingParameter(): { type: 'enabled' | 'disabled' } {
    return this.capabilities.supportsReasoning
      ? { type: 'enabled' }
      : { type: 'disabled' };
  }

  // GLM stringifies content for non-vision models; vision models (GLM-4.5v,
  // GLM-4.6v) use the standard OpenAI image_url format.
  protected override readonly convertContentToStringUnlessVision = true;
}

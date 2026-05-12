// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

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
export class ModelHandlerGLM extends ModelHandlerOpenAI {
  protected override useReasoningStreamAggregator = true;

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

  /**
   * GLM thinking models require reasoning_content in tool-use follow-up messages
   * to maintain reasoning chain coherence across tool calls.
   */
  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
  }

  /**
   * GLM requires content to be converted to strings for non-vision models.
   * Vision models (GLM-4.5v, GLM-4.6v) use standard OpenAI image_url format.
   */
  protected override getMessageNormalizationOptions():
    | NormalizeOpenAIMessageContentOptions
    | undefined {
    if (this.capabilities.supportsVision) {
      return undefined;
    }
    return { convertContentToString: true };
  }
}

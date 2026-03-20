// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

/**
 * Handler for MiniMax models using OpenAI-compatible API.
 *
 * MiniMax M-series are interleaved thinking models. Their reasoning behavior
 * differs from the standard `reasoning_content` convention used by DeepSeek/GLM:
 *
 * - **Streaming**: The `reasoning_content` field in deltas is EMPTY. Thinking is
 *   embedded in `<think>...</think>` tags within `delta.content`. This is by design:
 *   the OpenAI ChatCompletion format doesn't natively support thinking pass-back,
 *   so MiniMax injects thinking into the content field.
 *
 * - **Non-streaming**: `reasoning_content` on the message IS populated correctly.
 *   The base OpenAI handler extracts it automatically.
 *
 * - **Tool calls**: The full content (with `<think>` tags) is naturally preserved
 *   in the assistant message, maintaining the reasoning chain. We do NOT use
 *   `shouldIncludeReasoningInToolCalls()` since reasoning_content would be empty.
 *
 * We intentionally do NOT use BaseReasoningStreamAggregator here — it would look
 * for `reasoning_content` in streaming deltas and find nothing.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 * @see https://platform.minimax.io/docs/guides/text-m2-function-call
 */
export class ModelHandlerMiniMax extends ModelHandlerOpenAI {
  /**
   * MiniMax requires content to be converted to strings for non-vision models.
   * Vision models use standard OpenAI image_url format.
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

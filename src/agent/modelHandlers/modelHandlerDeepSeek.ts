// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type { DeepSeekToolCall } from './types/IModelHandler';

// DeepSeek usage format includes prompt_cache_hit_tokens which the base class
// already handles via rawUsage.prompt_cache_hit_tokens in normalizeUsage().

/**
 * Handler for DeepSeek models using OpenAI-compatible API.
 *
 * Supports DeepSeek's thinking mode with tool calls. When thinking mode is enabled:
 * - The model outputs reasoning_content along with tool_calls
 * - The reasoning_content must be included in assistant messages during tool-use cycles
 *
 * Reasoning content lifecycle:
 * - Captured in processThinkingBlock() on each model response
 * - Consumed (and cleared) when creating tool-use follow-up messages
 * - Overwritten on next model response if not consumed (no leak between turns)
 *
 * Note: Handler instances are created per-agent-run, not shared across requests.
 *
 * @see https://api-docs.deepseek.com/guides/thinking_with_tools
 */
export class ModelHandlerDeepSeek extends ModelHandlerOpenAI<DeepSeekToolCall> {
  // toolCallProvider and usageProvider inherit from base class via config.provider

  /**
   * DeepSeek models don't support vision/attachments in tool results.
   */
  override get canProcessToolResultAttachments(): boolean {
    return false;
  }

  /**
   * DeepSeek expects string content format instead of array format.
   */
  protected override formatAssistantContent(text: string): string {
    return text;
  }

  /**
   * DeepSeek thinking models require reasoning_content in tool-use follow-up messages.
   */
  protected override shouldIncludeReasoningInToolCalls(): boolean {
    return this.capabilities.supportsReasoning;
  }

  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    // Only create aggregator when reasoning is enabled
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

  /**
   * DeepSeek requires merging consecutive roles and converting content to strings.
   */
  protected override getMessageNormalizationOptions(): NormalizeOpenAIMessageContentOptions {
    return {
      mergeConsecutiveRoles: true,
      convertContentToString: true,
    };
  }

  /**
   * DeepSeek supports thinking mode via:
   * - model="deepseek-reasoner" (thinking enabled by default)
   * - model="deepseek-chat" with thinking: {"type": "enabled"}
   */
  protected override getThinkingParameter():
    | { type: 'enabled' | 'disabled' }
    | undefined {
    const { fullName } = this.config;
    // deepseek-chat has thinking OFF by default, enable if supportsReasoning
    if (fullName === 'deepseek-chat' && this.capabilities.supportsReasoning) {
      return { type: 'enabled' };
    }
    // deepseek-reasoner has thinking ON by default, disable if !supportsReasoning
    if (
      fullName === 'deepseek-reasoner' &&
      !this.capabilities.supportsReasoning
    ) {
      return { type: 'disabled' };
    }
    return undefined;
  }
}

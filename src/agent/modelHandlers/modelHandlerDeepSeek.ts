// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type { DeepSeekToolCall } from './types/IModelHandler';

// DeepSeek usage format includes prompt_cache_hit_tokens which the base class
// already handles via rawUsage.prompt_cache_hit_tokens in normalizeUsage().

/**
 * DeepSeek fullNames whose API default is thinking OFF.
 * All other recognized DeepSeek models default thinking ON, including:
 * - deepseek-reasoner (legacy V3.2 thinking alias)
 * - deepseek-v4-flash, deepseek-v4-pro (V4 series, thinking default per DeepSeek docs)
 */
const THINKING_DEFAULT_OFF_FULLNAMES = new Set<string>(['deepseek-chat']);

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
   * DeepSeek supports thinking mode via an optional `thinking: {type}` param.
   * The API default differs per model:
   * - deepseek-chat (legacy V3.2 non-thinking): default OFF
   * - deepseek-reasoner (legacy V3.2 thinking alias): default ON
   * - deepseek-v4-flash, deepseek-v4-pro (V4 series): default ON
   *
   * We only send an explicit param when the desired mode differs from the
   * model's default; otherwise we omit it to stay compatible with providers
   * that don't understand the field.
   */
  protected override getThinkingParameter():
    | { type: 'enabled' | 'disabled' }
    | undefined {
    const { fullName } = this.config;
    const defaultsOff = THINKING_DEFAULT_OFF_FULLNAMES.has(fullName);
    const wantsThinking = this.capabilities.supportsReasoning;
    if (defaultsOff && wantsThinking) return { type: 'enabled' };
    if (!defaultsOff && !wantsThinking) return { type: 'disabled' };
    return undefined;
  }
}

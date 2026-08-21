// Third-party imports
import { ReasoningEffort } from 'llm-zoo';

// Local file imports
import type { DeepSeekToolCall } from '@agent/types/ModelHandlerContracts';
import { clampReasoningEffortToHighOrMax } from '@agent/modelHandlers/support/reasoningEffort';
import { ReasoningModelHandlerOpenAI } from './reasoningModelHandlerOpenAI';

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
 * - Copied into tool-use assistant messages, which remain in conversation history
 * - Cleared from transient workspace state after the follow-up message is built
 * - Overwritten on next model response if not consumed (no leak between turns)
 *
 * Note: Handler instances are created per-agent-run, not shared across requests.
 *
 * @see https://api-docs.deepseek.com/guides/thinking_with_tools
 */
export class ModelHandlerDeepSeek extends ReasoningModelHandlerOpenAI<DeepSeekToolCall> {
  // toolCallProvider and usageProvider inherit from base class via config.provider
  // useReasoningStreamAggregator + shouldIncludeReasoningInToolCalls inherit
  // from ReasoningModelHandlerOpenAI.

  /**
   * DeepSeek's tool-result format doesn't accommodate attachment content, so
   * attachment summaries are suppressed entirely. Not derived from
   * `capabilities.supportsVision` — that flag is about image understanding
   * in normal turns, not whether the tool-result format can carry an
   * attachment summary. `deepseekvision` is proof the two are independent,
   * not coincidental: it has `supportsVision: true` while this still
   * returns `false` (#7101 triage: see the base getter's doc comment for
   * why this stays a per-provider override).
   */
  protected override get canProcessToolResultAttachments(): boolean {
    return false;
  }

  /**
   * DeepSeek expects string content format instead of array format.
   */
  protected override formatAssistantContent(text: string): string {
    return text;
  }

  /**
   * DeepSeek also requires reasoning_content on final assistant messages after
   * a tool-use turn; otherwise the next queued follow-up can be rejected.
   */
  protected override shouldIncludeReasoningInAssistantMessages(): boolean {
    return this.capabilities.supportsReasoning;
  }

  /**
   * DeepSeek's examples pass back `content` beside `reasoning_content` and
   * `tool_calls`, even when content is the empty string.
   */
  protected override shouldIncludeEmptyAssistantToolContent(): boolean {
    return true;
  }

  /**
   * DeepSeek V4 thinking supports effort control. llm-zoo 1.4.2 does not mark
   * these models as configurable yet, so treat DeepSeek thinking models as
   * effort-capable here.
   */
  protected override getEffectiveReasoningEffort(): ReasoningEffort | null {
    if (!this.capabilities.supportsReasoning) return null;
    return this.capabilities.reasoningEffort ?? ReasoningEffort.HIGH;
  }

  /**
   * DeepSeek's OpenAI-format API accepts only high/max; delegate to the shared
   * high-or-max clamp (see `clampReasoningEffortToHighOrMax`).
   */
  protected override validateReasoningEffort(effort: string): string {
    return clampReasoningEffortToHighOrMax(effort);
  }

  /**
   * DeepSeek requires merging consecutive roles and stringified content —
   * except on `deepseekvision` (llm-zoo 1.30.0), which needs the array
   * content shape to carry image parts.
   */
  protected override readonly convertContentToStringUnlessVision = true;
  protected override readonly mergeConsecutiveRoles = true;

  /**
   * DeepSeek rejects a named tool choice while thinking mode is enabled.
   * Tool-use flows can still ask explicitly for the terminal tool in an
   * unforced follow-up turn.
   */
  override get supportsForcedToolChoice(): boolean {
    return !this.capabilities.supportsReasoning;
  }

  /**
   * DeepSeek's `thinking` param is only sent when the desired mode differs
   * from the model's API default. `deepseek-chat` defaults OFF; everything
   * else (`deepseek-reasoner`, V4 series) defaults ON.
   */
  protected override getThinkingParameter():
    { type: 'enabled' | 'disabled' } | undefined {
    const wantsThinking = this.capabilities.supportsReasoning;
    const defaultsOn = this.config.fullName !== 'deepseek-chat';
    if (defaultsOn === wantsThinking) return undefined;
    return { type: wantsThinking ? 'enabled' : 'disabled' };
  }
}

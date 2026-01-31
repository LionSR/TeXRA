// Third-party imports
import OpenAI from 'openai';

// Local file imports
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ToolFileAttachment } from '@tools/result';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import {
  formatToolResultAsText,
  type ToolResultPayload,
} from './utils/toolAttachmentUtils';
import type { NormalizeOpenAIMessageContentOptions } from './openAIMessageUtils';

// Type imports
import type { DeepSeekToolCall } from './types/IModelHandler';
import type {
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
} from 'openai/resources/chat/completions';

// DeepSeek usage format includes prompt_cache_hit_tokens which the base class
// already handles via rawUsage.prompt_cache_hit_tokens in normalizeUsage().

/**
 * Extended assistant message type with DeepSeek's reasoning_content field.
 * This is required for thinking mode with tool calls.
 */
type DeepSeekAssistantMessage = ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
};

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

  protected override createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    // Only create aggregator when reasoning is enabled
    return this.capabilities.supportsReasoning
      ? new BaseReasoningStreamAggregator()
      : null;
  }

  /**
   * Builds an assistant message with tool calls and reasoning_content.
   * Reads reasoning from workspaceState and clears it after use.
   *
   * This follows the same pattern as Anthropic/Google handlers:
   * - processThinkingBlock() stores to workspaceState.reasoning
   * - createToolUseFollowUpMessages() reads and clears via this method
   */
  private buildAssistantMessageWithReasoning(
    toolCalls: ReturnType<typeof this.normalizeToolCall>[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): DeepSeekAssistantMessage {
    const callMsg: DeepSeekAssistantMessage = {
      role: 'assistant',
      tool_calls: toolCalls,
    };

    // Include reasoning_content from workspaceState if available
    const reasoningContent =
      workspaceState?.reasoning.thinkingBlocks[0]?.thinking;
    if (reasoningContent) {
      callMsg.reasoning_content = reasoningContent;
      // Clear after use (same pattern as Anthropic handler)
      workspaceState?.resetReasoning();
    }

    if (text) {
      callMsg.content = this.formatAssistantContent(text);
    }

    return callMsg;
  }

  // processThinkingBlock is inherited from base class - it already stores
  // reasoning to workspaceState.reasoning.thinkingBlocks

  /**
   * Creates tool-use follow-up messages with reasoning_content support.
   *
   * For DeepSeek thinking mode, the assistant message must include
   * reasoning_content when tool calls are made. This allows the model
   * to continue its reasoning chain across tool-use cycles.
   *
   * Follows the same pattern as Anthropic handler:
   * - Reads reasoning from workspaceState.reasoning.thinkingBlocks
   * - Clears reasoning after including it in the message
   *
   * Attachments are ignored since DeepSeek doesn't support them.
   */
  override async createToolUseFollowUpMessages(
    _client: OpenAI | undefined,
    call: DeepSeekToolCall,
    result: ToolResultPayload,
    _attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    const toolCall = this.normalizeToolCall(call.raw);
    const callMsg = this.buildAssistantMessageWithReasoning(
      [toolCall],
      workspaceState,
      text,
    );

    // Result is already sanitized by source - attachments are ignored
    // Use plain text instead of JSON (Claude Code pattern) to save tokens
    const resultMsg = {
      role: 'tool' as const,
      tool_call_id: toolCall.id,
      content: formatToolResultAsText(result),
    };

    // Type assertion needed: DeepSeekAssistantMessage extends ChatCompletionAssistantMessageParam
    // with reasoning_content field that OpenAI's types don't know about
    return [callMsg as ChatCompletionMessageParam, resultMsg];
  }

  /**
   * Creates batched tool-use follow-up messages for multiple parallel tool calls.
   *
   * For DeepSeek thinking mode, all tool calls from a single model response
   * should be in ONE assistant message with reasoning_content, followed by
   * individual tool result messages.
   *
   * Attachments are ignored since DeepSeek doesn't support them.
   *
   * @param calls - Array of tool calls from the model response
   * @param results - Array of sanitized results (same order as calls)
   * @param _attachmentsPerCall - Array of attachment arrays (ignored for DeepSeek)
   * @param workspaceState - Workspace state containing reasoning blocks
   * @param text - Optional text content to include in the assistant message
   * @throws Error if calls and results arrays have different lengths
   */
  async createBatchedToolUseFollowUpMessages(
    calls: DeepSeekToolCall[],
    results: ToolResultPayload[],
    attachmentsPerCall: ToolFileAttachment[][],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<ChatCompletionMessageParam[]> {
    // Validate input arrays (consistent with Google handler)
    if (calls.length !== results.length) {
      throw new Error(
        `DeepSeek batched tool calls mismatch: ${calls.length} calls vs ${results.length} results`,
      );
    }

    if (calls.length !== attachmentsPerCall.length) {
      throw new Error(
        `DeepSeek batched tool calls mismatch: ${calls.length} calls vs ${attachmentsPerCall.length} attachment arrays`,
      );
    }

    // Early return for empty input (after validation)
    if (calls.length === 0) {
      return [];
    }

    // Build assistant message with ALL tool calls and reasoning_content
    const toolCalls = calls.map((call) => this.normalizeToolCall(call.raw));
    const callMsg = this.buildAssistantMessageWithReasoning(
      toolCalls,
      workspaceState,
      text,
    );

    // Type assertion needed: DeepSeekAssistantMessage extends ChatCompletionAssistantMessageParam
    // with reasoning_content field that OpenAI's types don't know about
    // Build tool result messages - use plain text instead of JSON to save tokens
    const toolResultMessages = toolCalls.map((call, i) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content: formatToolResultAsText(results[i]),
    }));

    return [callMsg as ChatCompletionMessageParam, ...toolResultMessages];
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

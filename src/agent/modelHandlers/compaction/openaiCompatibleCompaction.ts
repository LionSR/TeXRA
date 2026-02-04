/**
 * Shared compaction implementation for OpenAI-compatible providers.
 * Used by: ModelHandlerOpenAI, ModelHandlerDeepSeek, ModelHandlerKimi
 *
 * These providers all use the same OpenAI SDK format for chat completions,
 * so we can share the compaction logic.
 */

import type { OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { SummarizationResult } from './types';
import { DEFAULT_SUMMARY_PROMPT, SUMMARY_TAG } from './compactionPrompt';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

/**
 * Performs context summarization using an OpenAI-compatible API.
 *
 * @param client - OpenAI SDK client (works with any OpenAI-compatible endpoint)
 * @param messages - Current conversation messages
 * @param systemPrompt - System prompt to include for context
 * @param compactionModel - Model to use for summarization
 * @param summaryPrompt - Prompt to use for summarization (defaults to DEFAULT_SUMMARY_PROMPT)
 * @returns Promise resolving to the summarization result
 */
export async function compactOpenAICompatible(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  systemPrompt: string,
  compactionModel: string,
  summaryPrompt: string = DEFAULT_SUMMARY_PROMPT,
): Promise<SummarizationResult> {
  // Remove pending tool_use blocks from last assistant message
  const cleanedMessages = cleanMessagesForCompaction(messages);

  // Build messages with system prompt and summary request
  const compactionMessages: ChatCompletionMessageParam[] = [
    ...(systemPrompt
      ? [{ role: 'system' as const, content: systemPrompt }]
      : []),
    ...cleanedMessages,
    { role: 'user', content: summaryPrompt },
  ];

  // Non-streaming call to compaction model
  const response = await client.chat.completions.create({
    model: compactionModel,
    messages: compactionMessages,
    stream: false,
  });

  const rawSummary = response.choices[0]?.message?.content ?? '';

  // Extract summary from tags if present, otherwise use raw response
  const summary = extractTextFromTag(rawSummary, SUMMARY_TAG) || rawSummary;

  return {
    summary,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

/**
 * Cleans messages for compaction by removing pending tool calls from the last assistant message.
 * This follows the Anthropic SDK pattern.
 */
function cleanMessagesForCompaction(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (messages.length === 0) {
    return messages;
  }

  const cleaned = [...messages];
  const lastMsg = cleaned[cleaned.length - 1];

  // Only process if last message is from assistant
  if (lastMsg?.role !== 'assistant') {
    return cleaned;
  }

  // Check if content is an array (structured content)
  if (Array.isArray(lastMsg.content)) {
    // Filter out tool_call parts
    const nonToolParts = lastMsg.content.filter(
      (part: any) => part.type !== 'tool_call',
    );

    if (nonToolParts.length > 0) {
      cleaned[cleaned.length - 1] = {
        ...lastMsg,
        content: nonToolParts,
      };
    } else {
      // No non-tool content, remove the message entirely
      cleaned.pop();
    }
  }

  // Also remove tool_calls field if present
  if ('tool_calls' in lastMsg && lastMsg.tool_calls) {
    const { tool_calls: _, ...msgWithoutTools } = lastMsg;
    cleaned[cleaned.length - 1] = msgWithoutTools as ChatCompletionMessageParam;
  }

  return cleaned;
}

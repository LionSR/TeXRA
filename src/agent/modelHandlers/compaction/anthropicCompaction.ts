/**
 * Anthropic-specific compaction implementation.
 * Uses the Anthropic SDK's native message format for summarization.
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

import type { SummarizationResult } from './types';
import {
  COMPACTION_MAX_TOKENS,
  DEFAULT_SUMMARY_PROMPT,
  SUMMARY_TAG,
} from './compactionPrompt';
import { extractTextFromTag } from '@utils/text/xmlExtraction';

/**
 * Performs context summarization using the Anthropic API.
 *
 * @param client - Anthropic SDK client
 * @param messages - Current conversation messages
 * @param systemPrompt - System prompt to use
 * @param compactionModel - Model to use for summarization
 * @param summaryPrompt - Prompt to use for summarization (defaults to DEFAULT_SUMMARY_PROMPT)
 * @returns Promise resolving to the summarization result
 */
export async function compactAnthropic(
  client: Anthropic,
  messages: MessageParam[],
  systemPrompt: string,
  compactionModel: string,
  summaryPrompt: string = DEFAULT_SUMMARY_PROMPT,
): Promise<SummarizationResult> {
  // Remove pending tool_use blocks from last assistant message
  const cleanedMessages = cleanMessagesForCompaction(messages);

  // Append summary prompt as user message
  const compactionMessages: MessageParam[] = [
    ...cleanedMessages,
    { role: 'user', content: summaryPrompt },
  ];

  // Non-streaming call to compaction model (no thinking, no extended features)
  const response = await client.messages.create({
    model: compactionModel,
    max_tokens: COMPACTION_MAX_TOKENS,
    system: systemPrompt,
    messages: compactionMessages,
    stream: false,
  });

  // Extract text from response
  const rawSummary = response.content
    .filter(
      (block): block is { type: 'text'; text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n');

  // Extract summary from tags if present, otherwise use raw response
  const summary = extractTextFromTag(rawSummary, SUMMARY_TAG) || rawSummary;

  return {
    summary,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Cleans messages for compaction by removing pending tool_use blocks from the last assistant message.
 * This follows the Anthropic SDK pattern.
 */
function cleanMessagesForCompaction(messages: MessageParam[]): MessageParam[] {
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
    const content = lastMsg.content as ContentBlockParam[];

    // Filter out tool_use blocks
    const nonToolBlocks = content.filter(
      (block: ContentBlockParam) => block.type !== 'tool_use',
    );

    if (nonToolBlocks.length > 0) {
      cleaned[cleaned.length - 1] = {
        ...lastMsg,
        content: nonToolBlocks,
      };
    } else {
      // No non-tool content, remove the message entirely
      cleaned.pop();
    }
  }

  return cleaned;
}

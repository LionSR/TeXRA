import { takeTail } from '@common/errors/sdkErrorUtils';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletionSnapshot } from 'openai/lib/ChatCompletionStream';

// Reasoning content type for DeepSeek, o1 models (not in SDK)
type ReasoningContent = string | Array<{ type: string; text?: string }>;

function extractReasoningText(content: ReasoningContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
}

/** Extracts `reasoning_content` from a streaming chunk delta. */
export function extractReasoningDelta(chunk: ChatCompletionChunk): string {
  const delta = chunk.choices[0]?.delta as
    | { reasoning_content?: ReasoningContent }
    | undefined;
  if (!delta || !('reasoning_content' in delta)) return '';
  return extractReasoningText(delta.reasoning_content);
}

/**
 * Extracts a capped tail of the assistant content accumulated by the SDK's
 * ChatCompletionStream in its currentChatCompletionSnapshot. Returns the
 * suffix because continuation prompts reference the tail of the response.
 */
export function extractOpenAIPartialTail(
  snapshot: ChatCompletionSnapshot | undefined,
  maxChars: number,
): string {
  const content = snapshot?.choices?.[0]?.message?.content ?? '';
  return takeTail(content, maxChars);
}

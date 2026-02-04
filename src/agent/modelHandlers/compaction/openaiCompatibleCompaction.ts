// Third-party imports
import OpenAI from 'openai';

// Type imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Shared compaction implementation for OpenAI-compatible providers.
 * Used by: ModelHandlerOpenAI, ModelHandlerDeepSeek, ModelHandlerKimi
 */
export async function compactOpenAICompatible(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  compactionModel: string,
  summaryPrompt: string,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> {
  const compactionMessages: ChatCompletionMessageParam[] = [
    ...messages,
    { role: 'user', content: summaryPrompt },
  ];

  const response = await client.chat.completions.create({
    model: compactionModel,
    messages: compactionMessages,
    stream: false,
  });

  const summary = response.choices[0]?.message?.content ?? '';
  return {
    summary,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

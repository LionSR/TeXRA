// Third-party imports
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export async function compactOpenAICompatible(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  compactionModel: string,
  summaryPrompt: string,
  extraHeaders?: Record<string, string>,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> {
  const response = await client.chat.completions.create({
    model: compactionModel,
    messages: [...messages, { role: 'user', content: summaryPrompt }],
    stream: false,
    ...(extraHeaders ? { extra_headers: extraHeaders } : {}),
  });

  const summary = response.choices[0]?.message?.content ?? '';
  return {
    summary,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

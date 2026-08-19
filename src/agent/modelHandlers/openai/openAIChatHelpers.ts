import type { AgentTrace } from '@agent/trace';
import type { ModelCredentialRoute } from '@agent/types/ModelHandlerContracts';
import { takeTail } from '@common/errors/sdkError/errorPatterns';
import {
  resolveDirectModelApiKeyProvider,
  type ResolvedModelConfig,
} from '@model/openRouterRouting';
import { shouldUseOpenRouter } from '../support/ProxyConfigResolver';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletionSnapshot } from 'openai/lib/ChatCompletionStream';

// Reasoning content type for DeepSeek, o1 models (not in SDK)
type ReasoningContent = string | { type: string; text?: string }[];

/** Extracts `reasoning_content` from a streaming chunk delta. */
export function extractReasoningDelta(chunk: ChatCompletionChunk): string {
  const delta = chunk.choices[0]?.delta as
    { reasoning_content?: ReasoningContent } | undefined;
  const content = delta?.reasoning_content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((item) => item.text ?? '').join('');
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

/**
 * Log the resolved credential route and final wire request config for an
 * OpenAI-compatible client. OpenAI-subtree handlers only — kept off the base
 * `ModelHandler` so non-OpenAI providers don't carry OpenAI credential-label
 * derivation on their surface.
 */
export function logOpenAICompatibleClientConfig(
  logger: AgentTrace,
  config: ResolvedModelConfig,
  baseURL: string,
  route: ModelCredentialRoute | undefined,
): void {
  let credential: string;
  if (route === 'chatgpt-subscription') {
    credential = 'ChatGPT subscription';
  } else if (route === 'xai-subscription') {
    credential = 'Grok subscription';
  } else if (
    route === 'openrouter' ||
    (route === undefined && shouldUseOpenRouter(config))
  ) {
    credential = 'OpenRouter API key';
  } else {
    const provider =
      resolveDirectModelApiKeyProvider(config) ?? config.provider;
    credential = `${provider} API key`;
  }
  logger.debug(
    `Using ${credential}. Model: ${config.fullName}. Base URL: ${baseURL}`,
  );
}

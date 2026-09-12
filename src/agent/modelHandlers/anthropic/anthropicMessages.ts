// Local imports
import type { AgentTrace } from '@agent/trace';
import type { AssistantTextAppendOptions } from '../ModelHandler';

// Third-party imports
import type {
  ContentBlockParam,
  MessageParam,
  RedactedThinkingBlockParam,
  ThinkingBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * Build a text content block. The explicit return type resolves the union
 * inference, so no call site needs an `as ContentBlockParam` cast.
 */
export function textBlock(text: string): ContentBlockParam {
  return { type: 'text', text };
}

/** Type guard for any thinking-related content block param */
const isAnyThinkingBlockParam = (
  block: ContentBlockParam,
): block is ThinkingBlockParam | RedactedThinkingBlockParam =>
  block.type === 'thinking' || block.type === 'redacted_thinking';

/** Handler capabilities {@link appendTextToLastAssistantMessage} reads, bound by the handler. */
interface AnthropicAssistantMessageDeps {
  logger: AgentTrace;
  containCutOffMessage(
    content: Array<{ type: string; text?: string }> | string,
  ): boolean;
}

export function appendTextToLastAssistantMessage(
  messages: MessageParam[],
  text: string,
  options: AssistantTextAppendOptions = {},
  deps: AnthropicAssistantMessageDeps,
): boolean {
  let targetIndex = messages.length - 1;
  const trailingMessage = messages.at(-1);

  if (options.afterContinuationPrompt) {
    if (!trailingMessage || trailingMessage.role !== 'user') return false;
    if (
      !Array.isArray(trailingMessage.content) ||
      !deps.containCutOffMessage(trailingMessage.content)
    ) {
      return false;
    }
    targetIndex = messages.length - 2;
  }

  const targetMessage = messages.at(targetIndex);
  if (!targetMessage || targetMessage.role !== 'assistant') return false;

  if (Array.isArray(targetMessage.content)) {
    if (options.afterContinuationPrompt) {
      const thinkingCount = targetMessage.content.filter(
        isAnyThinkingBlockParam,
      ).length;
      if (thinkingCount > 0) {
        deps.logger.debug(
          `Using ${thinkingCount} existing thinking blocks from previous message`,
        );
      }
    }

    targetMessage.content.push(textBlock(text));
  } else {
    targetMessage.content = [textBlock(options.fallbackText ?? text)];
  }

  if (options.afterContinuationPrompt) {
    messages.pop();
  }
  return true;
}

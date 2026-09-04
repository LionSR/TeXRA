// Local imports
import type { AgentTrace } from '@agent/trace';
import type { FileLocation, MediaAttachmentKind } from '@shared/schemas';
import type { AssistantTextAppendOptions } from '../ModelHandler';

// Third-party imports
import type {
  ContentBlockParam,
  MessageParam,
  RedactedThinkingBlockParam,
  TextBlockParam,
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

/** Type guard for text blocks in request content */
const isTextBlockParam = (block: ContentBlockParam): block is TextBlockParam =>
  block.type === 'text';

/** Handler capabilities {@link addMediaToUserMessage} reads, bound by the handler. */
interface AnthropicMediaMessageDeps {
  supportsVision: boolean;
  createMediaForRound(mediaFiles: FileLocation[]): Promise<ContentBlockParam[]>;
  consumeInsertedAttachmentKinds(): MediaAttachmentKind[];
}

/** Handler capabilities {@link appendTextToLastAssistantMessage} reads, bound by the handler. */
interface AnthropicAssistantMessageDeps {
  logger: AgentTrace;
  containCutOffMessage(
    content: Array<{ type: string; text?: string }> | string,
  ): boolean;
}

/**
 * Prepend text to the last user message in the conversation.
 */
export function prependTextToUserMessage(
  messages: MessageParam[],
  text: string,
): void {
  if (!text.trim()) return;

  const lastUserMsg = messages.findLast((m) => m.role === 'user');
  if (!lastUserMsg) return;

  if (typeof lastUserMsg.content === 'string') {
    lastUserMsg.content = text + lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg.content)) {
    const firstTextBlock = lastUserMsg.content.find(isTextBlockParam);
    if (firstTextBlock) {
      firstTextBlock.text = text + firstTextBlock.text;
    } else {
      lastUserMsg.content.unshift(textBlock(text));
    }
  }
}

/**
 * Add media files to the last user message in the conversation.
 */
export async function addMediaToUserMessage(
  messages: MessageParam[],
  mediaFiles: FileLocation[],
  deps: AnthropicMediaMessageDeps,
): Promise<MediaAttachmentKind[]> {
  if (!mediaFiles.length || !deps.supportsVision) return [];

  const lastUserMsg = messages.findLast((m) => m.role === 'user');
  if (!lastUserMsg) return [];

  const formattedMedia = await deps.createMediaForRound(mediaFiles);
  if (formattedMedia.length === 0) return [];

  if (typeof lastUserMsg.content === 'string') {
    lastUserMsg.content = [...formattedMedia, textBlock(lastUserMsg.content)];
  } else if (Array.isArray(lastUserMsg.content)) {
    lastUserMsg.content.unshift(...formattedMedia);
  }
  return deps.consumeInsertedAttachmentKinds();
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

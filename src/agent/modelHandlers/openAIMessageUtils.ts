// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - utilities
import { convertContentToString } from '@agent/utils/text/messageUtils';

/** Options for normalizing OpenAI-style chat messages. */
export interface NormalizeOpenAIMessageContentOptions {
  /** Merge consecutive messages that share the same role. */
  mergeConsecutiveRoles?: boolean;
  /** Convert array-based message content into newline-joined strings. */
  convertContentToString?: boolean;
}

type MessageLike = {
  role?: string;
  content?: unknown;
};

type ContentArray = Array<Record<string, unknown>>;

function cloneContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  return (content as ContentArray).map((part) =>
    part && typeof part === 'object' ? { ...part } : part,
  );
}

function cloneMessage<T extends MessageLike>(message: T): T {
  const cloned = { ...message } as T;
  if (Array.isArray(message.content)) {
    cloned.content = cloneContent(message.content);
  }
  return cloned;
}

function mergeMessageContent(
  previous: MessageLike,
  current: MessageLike,
): void {
  const prevContent = previous.content;
  const currContent = current.content;

  if (Array.isArray(prevContent) && Array.isArray(currContent)) {
    previous.content = [
      ...(prevContent as ContentArray),
      ...((cloneContent(currContent) as ContentArray) ?? []),
    ];
    return;
  }

  if (Array.isArray(prevContent) && typeof currContent === 'string') {
    if (currContent.length > 0) {
      previous.content = [
        ...(prevContent as ContentArray),
        { type: 'text', text: currContent },
      ];
    }
    return;
  }

  if (Array.isArray(currContent)) {
    const clonedCurrent = cloneContent(currContent);
    if (typeof prevContent === 'string' && prevContent.length > 0) {
      previous.content = [
        { type: 'text', text: prevContent },
        ...((clonedCurrent as ContentArray) ?? []),
      ];
      return;
    }

    if (
      prevContent === undefined ||
      prevContent === null ||
      (typeof prevContent === 'string' && prevContent.length === 0)
    ) {
      previous.content = clonedCurrent;
    }
    return;
  }

  if (typeof prevContent === 'string' && typeof currContent === 'string') {
    if (prevContent.length === 0) {
      previous.content = currContent;
    } else if (currContent.length === 0) {
      previous.content = prevContent;
    } else {
      previous.content = `${prevContent}\n${currContent}`;
    }
    return;
  }

  if (prevContent === undefined || prevContent === null) {
    previous.content = currContent;
  }
}

/**
 * Normalize OpenAI chat messages according to provided options.
 *
 * @param messages The original messages array.
 * @param options Normalization options controlling merging and content conversion.
 * @returns A normalized copy of the message array.
 */
export function normalizeOpenAIMessageContent<T extends MessageLike>(
  messages: T[],
  options?: NormalizeOpenAIMessageContentOptions,
): T[] {
  if (!Array.isArray(messages) || messages.length === 0 || !options) {
    return messages;
  }

  const {
    mergeConsecutiveRoles = false,
    convertContentToString: asString = false,
  } = options;

  let working: T[] = messages.map((message) => cloneMessage(message));

  if (mergeConsecutiveRoles) {
    const merged: T[] = [];

    for (const message of working) {
      const previous = merged.at(-1);
      if (!previous || previous.role !== message.role) {
        merged.push(message);
        continue;
      }

      mergeMessageContent(previous, message);
    }

    working = merged;
  }

  if (asString) {
    working.forEach((message) => {
      if (Array.isArray(message.content)) {
        message.content = convertContentToString(message.content);
      }
    });
  }

  return working;
}

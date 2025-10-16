// Third-party imports
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

export type MessageWithContent<T extends ChatCompletionContentPart = ChatCompletionContentPart> = {
  role: string;
  content?: string | T[];
  [key: string]: unknown;
};

type AppendablePart<T extends ChatCompletionContentPart> =
  | string
  | T
  | T[]
  | undefined
  | null;

export interface AppendTextContentOptions {
  /**
   * When true, any existing string content on the target message is discarded
   * before appending new parts. This mirrors legacy behaviour that replaced
   * assistant prefill strings with the accumulated tool output.
   */
  replaceExistingText?: boolean;
  /**
   * When true, the helper always creates a new message even if the last entry
   * already matches the requested role.
   */
  alwaysCreateNewMessage?: boolean;
}

function createTextPart<T extends ChatCompletionContentPart>(text: string): T {
  return { type: 'text', text } as T;
}

function ensureContentArray<T extends ChatCompletionContentPart>(
  message: MessageWithContent<T>,
  replaceExistingText: boolean,
): T[] {
  const { content } = message;

  if (Array.isArray(content)) {
    if (replaceExistingText) {
      message.content = [];
      return message.content as T[];
    }
    return content;
  }

  const normalized: T[] = [];

  if (!replaceExistingText && typeof content === 'string') {
    normalized.push(createTextPart<T>(content));
  }

  message.content = normalized;
  return normalized;
}

function normalizeParts<T extends ChatCompletionContentPart>(
  parts: AppendablePart<T>[],
): T[] {
  return parts.flatMap((part) => {
    if (part === null || part === undefined) {
      return [];
    }
    if (typeof part === 'string') {
      return [createTextPart<T>(part)];
    }
    if (Array.isArray(part)) {
      return part as T[];
    }
    return [part as T];
  });
}

/**
 * Appends text or media content to the trailing message with the provided role.
 * The helper normalises string content into OpenAI's array-based format so
 * callers can avoid repeated Array checks and coercion.
 *
 * @returns Object describing the mutated message and whether the helper
 *          appended to an existing entry.
 */
export function appendTextContent<
  T extends ChatCompletionContentPart = ChatCompletionContentPart,
>(
  messages: MessageWithContent<T>[],
  role: string,
  parts: AppendablePart<T>[],
  options: AppendTextContentOptions = {},
): { message: MessageWithContent<T>; appendedToExisting: boolean } {
  const normalizedParts = normalizeParts(parts);
  const {
    replaceExistingText = false,
    alwaysCreateNewMessage = false,
  } = options;

  const lastMessage = messages.at(-1);
  const shouldAppendToLast =
    !alwaysCreateNewMessage &&
    lastMessage !== undefined &&
    lastMessage.role === role;

  if (normalizedParts.length === 0) {
    if (shouldAppendToLast) {
      ensureContentArray(lastMessage, replaceExistingText);
      return { message: lastMessage, appendedToExisting: true };
    }

    const emptyMessage: MessageWithContent<T> = { role, content: [] };
    messages.push(emptyMessage);
    return { message: emptyMessage, appendedToExisting: false };
  }

  if (!shouldAppendToLast) {
    const newMessage: MessageWithContent<T> = {
      role,
      content: [...normalizedParts],
    };
    messages.push(newMessage);
    return { message: newMessage, appendedToExisting: false };
  }

  const contentArray = ensureContentArray(lastMessage, replaceExistingText);
  contentArray.push(...normalizedParts);
  return { message: lastMessage, appendedToExisting: true };
}

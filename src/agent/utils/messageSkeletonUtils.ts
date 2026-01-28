/**
 * Utility functions for working with message objects in agent conversations.
 */
import { MESSAGE_PREVIEW_LENGTH } from '@utils/config';

/**
 * Truncate a string if it exceeds maxLength, appending char count.
 */
function truncateString(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}... (${text.length} chars)`;
}

/**
 * Create skeleton for a content array item (common in Anthropic responses).
 */
function contentItemToSkeleton(item: unknown, maxLength: number): unknown {
  if (typeof item !== 'object' || item === null) {
    return typeof item;
  }

  const typedItem = item as Record<string, unknown>;
  const skeleton: Record<string, unknown> = { type: typedItem.type };

  // Handle text field
  if (typeof typedItem.text === 'string' && typedItem.text.length > 0) {
    skeleton.text = truncateString(typedItem.text, maxLength);
  }

  // Handle source field (for images)
  if (typeof typedItem.source === 'object' && typedItem.source !== null) {
    const source = typedItem.source as Record<string, unknown>;
    const sourceSkeleton: Record<string, unknown> = { type: source.type };
    if (source.media_type) {
      sourceSkeleton.media_type = source.media_type;
    }
    if (typeof source.data === 'string') {
      sourceSkeleton.data = `[base64 data: ${source.data.length} chars]`;
    }
    skeleton.source = sourceSkeleton;
  }

  // Handle cache control
  if (typedItem.cache_control) {
    skeleton.cache_control = typedItem.cache_control;
  }

  // Handle thinking field
  if (typeof typedItem.thinking === 'string') {
    skeleton.thinking = `[thinking data: ${typedItem.thinking.length} chars]`;
  }

  return skeleton;
}

/**
 * Creates a skeleton representation of a message object for debugging.
 * Preserves structure while truncating content to avoid cluttering logs.
 * @param message The message object to create a skeleton for
 * @param maxContentLength Maximum length of content strings before truncation
 * @returns A simplified message object with truncated content
 */
export function messageToSkeleton(
  message: unknown,
  maxContentLength: number = MESSAGE_PREVIEW_LENGTH,
): unknown {
  if (!message) return null;
  if (Array.isArray(message)) {
    return message.map((item) => messageToSkeleton(item, maxContentLength));
  }
  if (typeof message !== 'object') return typeof message;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(message)) {
    if (key === 'content') {
      if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          contentItemToSkeleton(item, maxContentLength),
        );
      } else if (typeof value === 'string') {
        result[key] = truncateString(value, maxContentLength);
      } else {
        result[key] = typeof value;
      }
    } else if (
      key === 'data' &&
      typeof value === 'string' &&
      value.length > maxContentLength
    ) {
      result[key] = `[data: ${value.length} chars]`;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = messageToSkeleton(value, maxContentLength);
    } else {
      result[key] = value;
    }
  }

  return result;
}

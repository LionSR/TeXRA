/**
 * Utility functions for working with message objects in agent conversations.
 */
import { MESSAGE_PREVIEW_LENGTH } from '@utils/config';

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
  if (!message) {
    return null;
  }

  if (Array.isArray(message)) {
    return message.map((item) => messageToSkeleton(item, maxContentLength));
  }

  if (typeof message !== 'object') {
    return typeof message;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(message)) {
    if (key === 'content') {
      if (Array.isArray(value)) {
        // Handle content arrays (common in Anthropic responses)
        result[key] = value.map((item: unknown) => {
          if (typeof item === 'object' && item !== null) {
            const typedItem = item as Record<string, unknown>;
            const itemSkeleton: Record<string, unknown> = {
              type: typedItem.type,
            };

            if (
              typeof typedItem.text === 'string' &&
              typedItem.text.length > 0
            ) {
              const text = typedItem.text;
              const truncatedText =
                text.length > maxContentLength
                  ? `${text.substring(0, maxContentLength)}... (${text.length} chars)`
                  : text;
              itemSkeleton.text = truncatedText;
            }

            if (
              typeof typedItem.source === 'object' &&
              typedItem.source !== null
            ) {
              const source = typedItem.source as Record<string, unknown>;
              const sourceSkeleton: Record<string, unknown> = {
                type: source.type,
              };
              if (source.media_type) {
                sourceSkeleton.media_type = source.media_type;
              }
              if (typeof source.data === 'string') {
                sourceSkeleton.data = `[base64 data: ${source.data.length} chars]`;
              }
              itemSkeleton.source = sourceSkeleton;
            }

            if (typedItem.cache_control) {
              itemSkeleton.cache_control = typedItem.cache_control;
            }

            if (typeof typedItem.thinking === 'string') {
              itemSkeleton.thinking = `[thinking data: ${typedItem.thinking.length} chars]`;
            }

            return itemSkeleton;
          }
          return typeof item;
        });
      } else if (typeof value === 'string') {
        // Handle string content
        result[key] =
          value.length > maxContentLength
            ? `${value.substring(0, maxContentLength)}... (${value.length} chars)`
            : value;
      } else {
        // Other content types
        result[key] = typeof value;
      }
    } else if (
      key === 'data' &&
      typeof value === 'string' &&
      value.length > maxContentLength
    ) {
      // Truncate large data strings
      result[key] = `[data: ${value.length} chars]`;
    } else if (typeof value === 'object' && value !== null) {
      // Recursively process nested objects
      result[key] = messageToSkeleton(value, maxContentLength);
    } else {
      // Pass through primitive values
      result[key] = value;
    }
  }

  return result;
}

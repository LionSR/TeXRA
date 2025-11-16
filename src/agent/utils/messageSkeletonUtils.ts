// Local imports - agent
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
/**
 * Utility functions for working with message objects in agent conversations.
 */

// Local imports
import { MESSAGE_PREVIEW_LENGTH } from '@utils/config';
import type {
  MessageSkeleton,
  ContentItemSkeleton,
} from '@common/types/MessageSkeleton';
import {
  isPlainObject,
  isContentItemArray,
} from '@common/types/MessageSkeleton';

/**
 * Creates a skeleton representation of a message object for debugging.
 * Preserves structure while truncating content to avoid cluttering logs.
 * @param message The message object to create a skeleton for
 * @param maxContentLength Maximum length of content strings before truncation
 * @returns A simplified message object with truncated content
 */
export function messageToSkeleton(
  message: ProviderMessage | ProviderMessage[],
  maxContentLength: number = MESSAGE_PREVIEW_LENGTH,
): MessageSkeleton | MessageSkeleton[] | null {
  if (!message) {
    return null;
  }

  if (Array.isArray(message)) {
    return message.map((item) => messageToSkeleton(item, maxContentLength));
  }

  if (!isPlainObject(message)) {
    return { _type: typeof message } as unknown as MessageSkeleton;
  }

  const result: MessageSkeleton = {};

  for (const [key, value] of Object.entries(message)) {
    if (key === 'content') {
      if (isContentItemArray(value)) {
        // Handle content arrays (common in Anthropic responses)
        result[key] = value.map((item) => {
          if (isPlainObject(item)) {
            const itemSkeleton: ContentItemSkeleton = { type: String(item.type) };

            if (item.text) {
              const truncatedText =
                item.text.length > maxContentLength
                  ? `${item.text.substring(0, maxContentLength)}... (${item.text.length} chars)`
                  : item.text;
              itemSkeleton.text = truncatedText;
            }

            if (item.source) {
              itemSkeleton.source = { type: item.source.type };
              if (item.source.media_type) {
                itemSkeleton.source.media_type = item.source.media_type;
              }
              if (item.source.data) {
                itemSkeleton.source.data = `[base64 data: ${item.source.data.length} chars]`;
              }
            }

            if (item.cache_control) {
              itemSkeleton.cache_control = item.cache_control;
            }

            if (item.thinking) {
              itemSkeleton.thinking = `[thinking data: ${item.thinking.length} chars]`;
            }

            return itemSkeleton;
          }
          return { _type: typeof item };
        });
      } else if (typeof value === 'string') {
        // Handle string content
        result[key] =
          value.length > maxContentLength
            ? `${value.substring(0, maxContentLength)}... (${value.length} chars)`
            : value;
      } else {
        // Other content types
        result[key] = { _type: typeof value };
      }
    } else if (
      key === 'data' &&
      typeof value === 'string' &&
      value.length > maxContentLength
    ) {
      // Truncate large data strings
      result[key] = `[data: ${value.length} chars]`;
    } else if (isPlainObject(value)) {
      // Recursively process nested objects
      result[key] = messageToSkeleton(value as ProviderMessage, maxContentLength);
    } else {
      // Pass through primitive values
      result[key] = value;
    }
  }

  return result;
}

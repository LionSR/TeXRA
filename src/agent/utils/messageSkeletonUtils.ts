// Local imports - agent
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
/**
 * Utility functions for working with message objects in agent conversations.
 */

// Local imports
import { MESSAGE_PREVIEW_LENGTH } from '@utils/config';

/** Skeleton output type - simplified representation of message structure */
type MessageSkeleton = Record<string, unknown> | null | string;

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
): MessageSkeleton | MessageSkeleton[] {
  if (!message) {
    return null;
  }

  if (Array.isArray(message)) {
    // Each item in the array produces a single MessageSkeleton (not nested arrays)
    return message.map(
      (item) => messageToSkeleton(item, maxContentLength) as MessageSkeleton,
    );
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
            const itemObj = item as Record<string, unknown>;
            const itemSkeleton: Record<string, unknown> = { type: itemObj.type };

            const text = itemObj.text;
            if (typeof text === 'string') {
              const truncatedText =
                text.length > maxContentLength
                  ? `${text.substring(0, maxContentLength)}... (${text.length} chars)`
                  : text;
              itemSkeleton.text = truncatedText;
            }

            const source = itemObj.source as Record<string, unknown> | undefined;
            if (source && typeof source === 'object') {
              const sourceInfo: Record<string, unknown> = { type: source.type };
              if (source.media_type) {
                sourceInfo.media_type = source.media_type;
              }
              const data = source.data;
              if (typeof data === 'string') {
                sourceInfo.data = `[base64 data: ${data.length} chars]`;
              }
              itemSkeleton.source = sourceInfo;
            }

            if (itemObj.cache_control) {
              itemSkeleton.cache_control = itemObj.cache_control;
            }

            const thinking = itemObj.thinking;
            if (typeof thinking === 'string') {
              itemSkeleton.thinking = `[thinking data: ${thinking.length} chars]`;
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
    } else if (
      typeof value === 'object' &&
      value !== null &&
      value !== undefined
    ) {
      // Recursively process nested objects
      // Cast to ProviderMessage for recursive call - safe because we're creating skeletons
      result[key] = messageToSkeleton(
        value as ProviderMessage,
        maxContentLength,
      );
    } else {
      // Pass through primitive values
      result[key] = value;
    }
  }

  return result;
}

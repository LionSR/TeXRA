/**
 * Type definitions for message skeleton structures used in debugging and logging.
 * Provides type-safe representations of message objects with truncated content.
 */

/**
 * Content item in a message skeleton (e.g., text, image, thinking blocks)
 */
export interface ContentItemSkeleton {
  type: string;
  text?: string;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
  };
  cache_control?: unknown;
  thinking?: string;
}

/**
 * Message skeleton that preserves structure while truncating content
 */
export interface MessageSkeleton {
  role?: string;
  content?: ContentItemSkeleton[] | string | string;
  [key: string]: unknown;
}

/**
 * Type guard to check if a value is an object (not null, not array)
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if content is a content item array
 */
export function isContentItemArray(
  content: unknown,
): content is Array<Record<string, unknown>> {
  return (
    Array.isArray(content) &&
    content.every((item) => typeof item === 'object' && item !== null)
  );
}

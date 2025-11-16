/**
 * Type definitions for message skeleton structures used in debugging and logging.
 * Provides flexible representations of message objects with truncated content.
 */

/**
 * Content item in a message skeleton - kept flexible for debugging
 */
export type ContentItemSkeleton = any;

/**
 * Message skeleton that preserves structure while truncating content
 */
export type MessageSkeleton = any;

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
    content.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
  );
}

/**
 * Type guards for message content structures.
 */

import { isString } from './stringCore';

interface ContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type MessageContent = string | ContentItem[];

function isTextContentItem(
  item: unknown,
): item is { type: 'text'; text: string } {
  return (
    item !== null &&
    typeof item === 'object' &&
    (item as ContentItem).type === 'text' &&
    typeof (item as ContentItem).text === 'string'
  );
}

/** Convert message content (string or array) to a string. */
export function contentToString(content: MessageContent): string {
  if (isString(content)) {
    return content;
  }
  return content
    .filter(isTextContentItem)
    .map((item) => item.text)
    .join('\n');
}

/** Check if value is a non-null object (not array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

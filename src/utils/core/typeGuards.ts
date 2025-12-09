/**
 * Centralized type guards for common data structures.
 *
 * This module provides type guards that are used across the codebase,
 * particularly in model handlers for message content manipulation.
 *
 * @module typeGuards
 */

import { isString, isNonEmptyString } from './stringCore';

// Re-export string type guards for convenience
export { isString, isNonEmptyString };

/**
 * Type for text content items in message arrays.
 */
export interface TextContentItem {
  type: 'text';
  text: string;
}

/**
 * Type for generic content items (may have other types like 'image').
 */
export interface ContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Message content can be either a string or array of content items.
 */
export type MessageContent = string | ContentItem[];

/**
 * Type guard: Check if value is an array.
 *
 * @param value - The value to check
 * @returns true if value is an array
 */
export function isArray<T = unknown>(value: unknown): value is T[] {
  return Array.isArray(value);
}

/**
 * Type guard: Check if content is a content array (not a string).
 *
 * @param content - The content to check
 * @returns true if content is an array of content items
 */
export function isContentArray(content: unknown): content is ContentItem[] {
  return Array.isArray(content);
}

/**
 * Type guard: Check if item is a text content item.
 *
 * @param item - The content item to check
 * @returns true if item is a text content item with text property
 */
export function isTextContentItem(item: unknown): item is TextContentItem {
  return (
    item !== null &&
    typeof item === 'object' &&
    (item as ContentItem).type === 'text' &&
    typeof (item as ContentItem).text === 'string'
  );
}

/**
 * Convert message content (string or array) to a string.
 *
 * If content is already a string, returns it as-is.
 * If content is an array, extracts text from text items and joins with newlines.
 *
 * @param content - The message content to convert
 * @returns String representation of the content
 *
 * @example
 * contentToString('hello') // 'hello'
 * contentToString([{ type: 'text', text: 'hello' }]) // 'hello'
 */
export function contentToString(content: MessageContent): string {
  if (isString(content)) {
    return content;
  }

  if (isContentArray(content)) {
    return content
      .filter(isTextContentItem)
      .map((item) => item.text)
      .join('\n');
  }

  return '';
}

/**
 * Ensure content is in string form.
 *
 * Similar to contentToString but handles null/undefined gracefully.
 *
 * @param content - The content to convert
 * @returns String content or empty string
 */
export function ensureStringContent(content: unknown): string {
  if (content === null || content === undefined) {
    return '';
  }
  if (isString(content)) {
    return content;
  }
  if (isContentArray(content)) {
    return contentToString(content);
  }
  return '';
}

/**
 * Check if value is a non-null object (not array).
 *
 * @param value - The value to check
 * @returns true if value is a plain object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check if value is a string array.
 *
 * @param value - The value to check
 * @returns true if value is an array of strings
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/**
 * Check if value has a specific property.
 *
 * @param obj - The object to check
 * @param prop - The property name
 * @returns true if object has the property
 */
export function hasProperty<K extends string>(
  obj: unknown,
  prop: K,
): obj is Record<K, unknown> {
  return isObject(obj) && prop in obj;
}

/**
 * Check if value has a string property.
 *
 * @param obj - The object to check
 * @param prop - The property name
 * @returns true if object has a string property with that name
 */
export function hasStringProperty<K extends string>(
  obj: unknown,
  prop: K,
): obj is Record<K, string> {
  return hasProperty(obj, prop) && isString(obj[prop]);
}

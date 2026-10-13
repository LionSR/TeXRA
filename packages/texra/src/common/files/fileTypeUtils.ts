// Internal imports
import { FILE_HANDLING_RULES } from './fileHandlingRules';

/**
 * File categories for the product's fixed file-handling rules.
 *
 * Note: This is distinct from DocumentFileType in @shared/schemas/fileTypes.ts
 * which defines UI file input field types.
 */
export type ExtensionCategory = 'input' | 'context' | 'media' | 'edited';

const INCLUDED_EXTENSIONS: Record<ExtensionCategory, readonly string[]> = {
  input: FILE_HANDLING_RULES.included.inputExtensions,
  context: FILE_HANDLING_RULES.included.contextExtensions,
  media: FILE_HANDLING_RULES.included.mediaExtensions,
  edited: FILE_HANDLING_RULES.included.editedExtensions,
};

/** Every extension category, for callers that aggregate them all. */
export const EXTENSION_CATEGORIES = Object.keys(
  INCLUDED_EXTENSIONS,
) as readonly ExtensionCategory[];

export function getIncludedExtensions(category: ExtensionCategory): string[] {
  return [...INCLUDED_EXTENSIONS[category]];
}

/**
 * Retrieve included extensions without the leading dot (for VS Code file filters).
 */
export function getFilterExtensions(category: ExtensionCategory): string[] {
  return getIncludedExtensions(category).map((ext) => ext.replace(/^\./, ''));
}

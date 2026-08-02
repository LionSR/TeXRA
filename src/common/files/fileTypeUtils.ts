// Internal imports
import { hasExtension } from '@utils/core/pathCore';

import { FILE_HANDLING_RULES } from './fileHandlingRules';

/**
 * File categories for the product's fixed file-handling rules.
 *
 * Note: This is distinct from DocumentFileType in utils/config/constants.ts
 * which defines UI file input field types.
 */
export type ExtensionCategory =
  'input' | 'context' | 'media' | 'audio' | 'edited';

const INCLUDED_EXTENSIONS: Record<ExtensionCategory, readonly string[]> = {
  input: FILE_HANDLING_RULES.included.inputExtensions,
  context: FILE_HANDLING_RULES.included.contextExtensions,
  media: FILE_HANDLING_RULES.included.mediaExtensions,
  audio: [],
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

/**
 * Returns true if the file has a .tex extension.
 */
export function isTexFile(filePath: string): boolean {
  return hasExtension(filePath, '.tex');
}

/**
 * LaTeX file extensions that can be compiled to PDF.
 */
const LATEX_EXTENSIONS = ['.tex', '.ltx', '.latex'] as const;

/**
 * Returns true if the file has a LaTeX extension (.tex, .ltx, .latex).
 * Use this for features that should work with all LaTeX document types.
 */
export function isLatexFile(filePath: string): boolean {
  return LATEX_EXTENSIONS.some((ext) => hasExtension(filePath, ext));
}

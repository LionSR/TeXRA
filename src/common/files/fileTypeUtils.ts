// Internal imports
import { getConfig } from '@utils/config';
import { hasExtension } from '@utils/core';

/**
 * File categories for extension configuration lookups.
 * These map to VS Code settings keys for allowed file extensions.
 *
 * Note: This is distinct from FileType in utils/config/constants.ts
 * which defines UI file input field types.
 */
export type ExtensionCategory =
  | 'input'
  | 'reference'
  | 'auxiliary'
  | 'media'
  | 'audio'
  | 'edited';

const INCLUDED_EXTENSION_KEYS: Record<ExtensionCategory, string> = {
  input: 'texra.files.included.inputExtensions',
  reference: 'texra.files.included.referenceExtensions',
  auxiliary: 'texra.files.included.auxiliaryExtensions',
  media: 'texra.files.included.mediaExtensions',
  audio: 'texra.files.included.audioExtensions',
  edited: 'texra.files.included.editedExtensions',
};

/**
 * Retrieve included extensions for the given extension category.
 */
export function getIncludedExtensions(
  category: ExtensionCategory,
  defaultExtensions: string[] = [],
): string[] {
  return getConfig<string[]>(
    INCLUDED_EXTENSION_KEYS[category],
    defaultExtensions,
  );
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
export const LATEX_EXTENSIONS = ['.tex', '.ltx', '.latex'] as const;

/**
 * Returns true if the file has a LaTeX extension (.tex, .ltx, .latex).
 * Use this for features that should work with all LaTeX document types.
 */
export function isLatexFile(filePath: string): boolean {
  return LATEX_EXTENSIONS.some((ext) => hasExtension(filePath, ext));
}

// Internal imports
import { DEFAULT_TEXRA_SETTINGS } from '@shared/schemas/settingsConfiguration';
import { getConfig } from '@utils/config/configUtils';
import { hasExtension } from '@utils/core/pathCore';

/**
 * File categories for extension configuration lookups.
 * These map to VS Code settings keys for allowed file extensions.
 *
 * Note: This is distinct from DocumentFileType in utils/config/constants.ts
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
 * Return the built-in extension defaults for a file category.
 */
function getDefaultIncludedExtensions(category: ExtensionCategory): string[] {
  const { included } = DEFAULT_TEXRA_SETTINGS.files;
  switch (category) {
    case 'input':
      return included.inputExtensions;
    case 'reference':
      return included.referenceExtensions;
    case 'auxiliary':
      return included.auxiliaryExtensions;
    case 'media':
      return included.mediaExtensions;
    case 'edited':
      return included.editedExtensions;
    case 'audio':
      return [];
  }
}

/**
 * Retrieve included extensions for the given extension category.
 */
export function getIncludedExtensions(category: ExtensionCategory): string[] {
  return getConfig<string[]>(
    INCLUDED_EXTENSION_KEYS[category],
    getDefaultIncludedExtensions(category),
  );
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
export const LATEX_EXTENSIONS = ['.tex', '.ltx', '.latex'] as const;

/**
 * Returns true if the file has a LaTeX extension (.tex, .ltx, .latex).
 * Use this for features that should work with all LaTeX document types.
 */
export function isLatexFile(filePath: string): boolean {
  return LATEX_EXTENSIONS.some((ext) => hasExtension(filePath, ext));
}

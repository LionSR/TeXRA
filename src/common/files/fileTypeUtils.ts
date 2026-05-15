// Internal imports
import { DEFAULT_TEXRA_SETTINGS } from '@shared/schemas/settingsConfiguration';
import {
  getConfig,
  inspectConfig,
  isConfigExplicitlySet,
} from '@utils/config/configUtils';
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
  | 'context'
  | 'media'
  | 'audio'
  | 'edited';

const INCLUDED_EXTENSION_KEYS: Record<ExtensionCategory, string> = {
  input: 'texra.files.included.inputExtensions',
  context: 'texra.files.included.contextExtensions',
  media: 'texra.files.included.mediaExtensions',
  audio: 'texra.files.included.audioExtensions',
  edited: 'texra.files.included.editedExtensions',
};

/** Legacy keys preserved so older user customizations carry through the rename. */
const LEGACY_REFERENCE_EXTENSIONS_KEY =
  'texra.files.included.referenceExtensions';
const LEGACY_AUXILIARY_EXTENSIONS_KEY =
  'texra.files.included.auxiliaryExtensions';
export const LEGACY_AUXILIARY_KEYWORDS_KEY =
  'texra.files.ignored.auxiliaryKeywords';

/**
 * Return the built-in extension defaults for a file category.
 */
function getDefaultIncludedExtensions(category: ExtensionCategory): string[] {
  const { included } = DEFAULT_TEXRA_SETTINGS.files;
  switch (category) {
    case 'input':
      return included.inputExtensions;
    case 'context':
      return included.contextExtensions;
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
 *
 * Back-compat: for `context`, fall back to the union of legacy
 * `referenceExtensions` and `auxiliaryExtensions` user values only when
 * the new key was never explicitly set — otherwise `getConfig()` would
 * mask the legacy customization with the new defaults.
 */
export function getIncludedExtensions(category: ExtensionCategory): string[] {
  const defaults = getDefaultIncludedExtensions(category);
  if (
    category === 'context' &&
    !isConfigExplicitlySet(INCLUDED_EXTENSION_KEYS.context)
  ) {
    const legacyRef = readUserSetting<string[]>(
      LEGACY_REFERENCE_EXTENSIONS_KEY,
    );
    const legacyAux = readUserSetting<string[]>(
      LEGACY_AUXILIARY_EXTENSIONS_KEY,
    );
    if (
      (legacyRef && legacyRef.length > 0) ||
      (legacyAux && legacyAux.length > 0)
    ) {
      return [...new Set([...(legacyRef ?? []), ...(legacyAux ?? [])])];
    }
  }
  return getConfig<string[]>(INCLUDED_EXTENSION_KEYS[category], defaults);
}

export function readUserSetting<T>(key: string): T | undefined {
  const inspected = inspectConfig<T>(key);
  return (
    inspected?.workspaceValue ??
    inspected?.workspaceFolderValue ??
    inspected?.globalValue
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

// Internal imports
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
import { unique } from '@utils/core';
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
  'input' | 'context' | 'media' | 'audio' | 'edited';

const { included } = DEFAULT_CORE_SETTINGS.files;

/** Settings key and built-in defaults for each configurable file category. */
const INCLUDED_EXTENSIONS: Record<
  ExtensionCategory,
  { key: string; defaults: string[] }
> = {
  input: {
    key: 'texra.files.included.inputExtensions',
    defaults: included.inputExtensions,
  },
  context: {
    key: 'texra.files.included.contextExtensions',
    defaults: included.contextExtensions,
  },
  media: {
    key: 'texra.files.included.mediaExtensions',
    defaults: included.mediaExtensions,
  },
  audio: { key: 'texra.files.included.audioExtensions', defaults: [] },
  edited: {
    key: 'texra.files.included.editedExtensions',
    defaults: included.editedExtensions,
  },
};

/** Every configurable extension category, for callers that aggregate them all. */
export const EXTENSION_CATEGORIES = Object.keys(
  INCLUDED_EXTENSIONS,
) as readonly ExtensionCategory[];

/** Legacy keys preserved so older user customizations carry through the rename. */
const LEGACY_REFERENCE_EXTENSIONS_KEY =
  'texra.files.included.referenceExtensions';
const LEGACY_AUXILIARY_EXTENSIONS_KEY =
  'texra.files.included.auxiliaryExtensions';
export const LEGACY_AUXILIARY_KEYWORDS_KEY =
  'texra.files.ignored.auxiliaryKeywords';

/**
 * Retrieve included extensions for the given extension category.
 *
 * Back-compat: for `context`, fall back to the union of legacy
 * `referenceExtensions` and `auxiliaryExtensions` user values only when
 * the new key was never explicitly set — otherwise `getConfig()` would
 * mask the legacy customization with the new defaults.
 */
export function getIncludedExtensions(category: ExtensionCategory): string[] {
  const { key, defaults } = INCLUDED_EXTENSIONS[category];
  if (category === 'context' && !isConfigExplicitlySet(key)) {
    const legacy = unique([
      ...(readUserSetting<string[]>(LEGACY_REFERENCE_EXTENSIONS_KEY) ?? []),
      ...(readUserSetting<string[]>(LEGACY_AUXILIARY_EXTENSIONS_KEY) ?? []),
    ]);
    if (legacy.length > 0) return legacy;
  }
  return getConfig<string[]>(key, defaults);
}

function readUserSetting<T>(key: string): T | undefined {
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
const LATEX_EXTENSIONS = ['.tex', '.ltx', '.latex'] as const;

/**
 * Returns true if the file has a LaTeX extension (.tex, .ltx, .latex).
 * Use this for features that should work with all LaTeX document types.
 */
export function isLatexFile(filePath: string): boolean {
  return LATEX_EXTENSIONS.some((ext) => hasExtension(filePath, ext));
}

// Internal imports
import type { DocumentFileType } from '@texra/shared/launcher/fileTypes';
import { FILE_HANDLING_RULES } from './fileHandlingRules';

/** The category's included extensions, as a fresh mutable copy. */
export function getIncludedExtensions(category: DocumentFileType): string[] {
  return [...FILE_HANDLING_RULES.included[category]];
}

/**
 * Retrieve included extensions without the leading dot, the form both the
 * VS Code and the Electron file dialogs filter by.
 */
export function getFilterExtensions(category: DocumentFileType): string[] {
  return getIncludedExtensions(category).map((ext) => ext.replace(/^\./, ''));
}

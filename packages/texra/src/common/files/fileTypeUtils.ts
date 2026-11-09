// Internal imports
import { DocumentFileTypeSchema } from '@texra/shared/launcher/fileTypes';
import { FILE_HANDLING_RULES } from './fileHandlingRules';

/**
 * File categories for the product's fixed file-handling rules: each document
 * file type (the launch form's input fields), plus `edited` for a run's
 * output files.
 */
export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number];

/** Every extension category, for callers that aggregate them all. */
export const EXTENSION_CATEGORIES = [
  ...DocumentFileTypeSchema.literals,
  'edited',
] as const;

/** The category's included extensions, as a fresh mutable copy. */
export function getIncludedExtensions(category: ExtensionCategory): string[] {
  return [...FILE_HANDLING_RULES.included[category]];
}

/**
 * Retrieve included extensions without the leading dot, the form both the
 * VS Code and the Electron file dialogs filter by.
 */
export function getFilterExtensions(category: ExtensionCategory): string[] {
  return getIncludedExtensions(category).map((ext) => ext.replace(/^\./, ''));
}

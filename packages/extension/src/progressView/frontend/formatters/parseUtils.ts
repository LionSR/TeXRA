/**
 * Display utilities for progress view formatters.
 * Provides text formatting helpers for rendering.
 *
 * For data validation and normalization, see:
 * - @shared/toolUse - normalizeToolUseData (shared with the CLI TUI)
 * - @shared/schemas - Zod schemas for simple validation
 */

// Third-party imports
import yaml from 'yaml';

// Local imports - shared utilities
import { isPlainObject } from '@shared/utils/string';

/**
 * Result of stringifying a value with language metadata.
 */
export type StringifyResult = {
  text: string;
  language: 'yaml' | 'json' | 'plaintext';
};

/**
 * Convert a value to a display-friendly string with language metadata.
 * Avoids repeated parsing by tracking the serialization format used.
 */
export function stringifyWithLanguage(value: unknown): StringifyResult {
  if (value === undefined || value === null) {
    return { text: '', language: 'plaintext' };
  }

  if (typeof value === 'string') {
    return { text: value, language: 'plaintext' };
  }

  try {
    const yamlString = yaml.stringify(value);
    const text = typeof yamlString === 'string' ? yamlString.trimEnd() : '';
    return { text, language: 'yaml' };
  } catch {
    return { text: String(value), language: 'plaintext' };
  }
}

/**
 * Extract the code/command field from a tool input object.
 * Supports 'code' field (wolfram) and 'command' field (bash).
 * Ignores metadata fields like `timeout` so the code is displayed
 * with proper syntax highlighting instead of falling back to YAML.
 */
export function extractCodeOnlyInput(value: unknown): {
  isCodeOnly: boolean;
  code: string;
} {
  if (!isPlainObject(value)) {
    return { isCodeOnly: false, code: '' };
  }
  // Support both 'code' (wolfram) and 'command' (bash) field names
  const codeValue = value.code ?? value.command;
  if (typeof codeValue === 'string') {
    return { isCodeOnly: true, code: codeValue };
  }
  return { isCodeOnly: false, code: '' };
}

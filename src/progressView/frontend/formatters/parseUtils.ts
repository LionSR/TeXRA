/**
 * Display utilities for progress view formatters.
 * Provides text formatting helpers for rendering.
 *
 * For data validation and normalization, see:
 * - logDataParsers.ts - Complex normalization (toolUse, fileList)
 * - @shared/schemas - Zod schemas for simple validation
 */

// Third-party imports
import yaml from 'yaml';

/**
 * Result of stringifying a value with language metadata.
 */
export type StringifyResult = {
  text: string;
  language: 'yaml' | 'json' | 'plaintext';
};

/** Check if value is a non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
 * Check if an input object is code-only (has only a code/command field with string content).
 * Supports 'code' field (wolfram) and 'command' field (bash).
 */
export function extractCodeOnlyInput(value: unknown): {
  isCodeOnly: boolean;
  code: string;
} {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) {
    return { isCodeOnly: false, code: '' };
  }
  // Support both 'code' (wolfram) and 'command' (bash) field names
  const codeValue = value.code ?? value.command;
  if (typeof codeValue === 'string') {
    return { isCodeOnly: true, code: codeValue };
  }
  return { isCodeOnly: false, code: '' };
}

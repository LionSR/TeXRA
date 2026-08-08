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

/**
 * Result of stringifying a value with language metadata.
 */
type StringifyResult = {
  text: string;
  language: 'yaml' | 'json' | 'plaintext';
};

/**
 * Convert a value to a display-friendly string with language metadata.
 * Avoids repeated parsing by tracking the serialization format used.
 */
export function stringifyWithLanguage(value: unknown): StringifyResult {
  if (value == null) {
    return { text: '', language: 'plaintext' };
  }

  if (typeof value === 'string') {
    return { text: value, language: 'plaintext' };
  }

  try {
    return { text: yaml.stringify(value).trimEnd(), language: 'yaml' };
  } catch {
    return { text: String(value), language: 'plaintext' };
  }
}

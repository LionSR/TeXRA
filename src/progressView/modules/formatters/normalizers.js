/**
 * Data normalization functions for progress view formatters.
 * These functions transform raw data into structured formats for rendering.
 *
 * ## Null/Undefined Handling Contracts
 *
 * Functions in this module follow these conventions:
 * - **Returns `null`**: Invalid input type (e.g., expected array but got object)
 * - **Returns empty string `''`**: Valid but empty/missing string value
 * - **Returns empty array `[]`**: Valid but empty collection
 * - **Returns object with defaults**: Valid input with missing optional fields
 *
 * | Function                      | Invalid Input Returns | Empty Input Returns          |
 * |-------------------------------|----------------------|------------------------------|
 * | normalizeFileListEntries      | `null`               | `[]` (empty array)           |
 * | normalizeMissingOutputsPayload| `null`               | `{missing:[], xmlFile:null}` |
 * | ensureLatexdiffArray          | `null`               | `[]` (passthrough)           |
 * | normalizeToolUseLog           | `null`               | object with empty strings    |
 * | extractTrimmedContent         | `{isEmpty: true}`    | `{isEmpty: true}`            |
 */

import yaml from 'yaml';
import { getBasename } from '@common/pathUtils.js';

/**
 * Return trimmed string if non-empty, null otherwise.
 * @param {*} value - Value to check
 * @returns {string|null} Trimmed string or null
 */
function trimmedOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Get first non-empty trimmed string from primary or fallback.
 * @param {*} primary - Primary source value
 * @param {*} fallback - Fallback source value
 * @returns {string} Trimmed string or empty string
 */
function firstTrimmed(primary, fallback) {
  return trimmedOrNull(primary) ?? trimmedOrNull(fallback) ?? '';
}

/**
 * Return value if it's a string, otherwise return fallback.
 * @param {*} value - Value to check
 * @param {string} fallback - Fallback value
 * @returns {string} Value or fallback
 */
function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/**
 * @typedef {Object} StringifyResult
 * @property {string} text - The stringified text
 * @property {string} language - Language hint for syntax highlighting ('yaml', 'json', 'plaintext')
 */

/**
 * Convert a value to a display-friendly string with language metadata.
 * Avoids repeated parsing by tracking the serialization format used.
 * @param {*} value - Value to stringify
 * @returns {StringifyResult} Object with text and language hint
 */
export function stringifyWithLanguage(value) {
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
 * Try to parse a string as JSON
 * @param {string} text - Text to parse
 * @returns {object|null} Parsed JSON or null
 */
export function tryParseJson(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Normalize structured content from text and data
 * @param {string} text - Raw text content
 * @param {*} data - Optional structured data
 * @returns {{decodedText: string, structured: *}} Normalized payload
 */
export function normalizeStructuredContent(text, data) {
  if (data !== undefined) {
    return { decodedText: '', structured: data };
  }

  const rawText = typeof text === 'string' ? text : '';
  return { decodedText: rawText, structured: tryParseJson(rawText) };
}

/**
 * Normalize file list entries from structured data
 * @param {Array} structured - Raw file list array
 * @returns {Array|null} Normalized file entries or null
 */
export function normalizeFileListEntries(structured) {
  if (!Array.isArray(structured)) return null;

  return structured.map((file) => {
    const filePath = String(file?.path ?? '');
    const source = file?.source || 'unknown';

    return {
      filePath,
      fileName: getBasename(filePath),
      ok: Boolean(file?.ok),
      source,
      sourceDisplay: stringOr(file?.sourceDisplay, source),
      internal: Boolean(file?.internal),
      varName: stringOr(file?.varName, ''),
    };
  });
}

/**
 * Normalize missing outputs payload
 * @param {object} structured - Raw missing outputs data
 * @returns {{missing: Array, xmlFile: string|null, documentTag: string|null}|null} Normalized payload
 */
export function normalizeMissingOutputsPayload(structured) {
  if (!structured) return null;

  return {
    missing: Array.isArray(structured.missing) ? structured.missing : [],
    xmlFile: trimmedOrNull(structured.xmlFile),
    documentTag: trimmedOrNull(structured.documentTag),
  };
}

/**
 * Ensure input is an array for latexdiff entries.
 * Returns the input unchanged if it's an array, null otherwise.
 * Does not validate individual entry structure.
 * @param {*} structured - Input to check
 * @returns {Array|null} Input array or null if not an array
 */
export function ensureLatexdiffArray(structured) {
  return Array.isArray(structured) ? structured : null;
}

/**
 * Check if value is a non-array object
 * @param {*} value - Value to check
 * @returns {boolean} True if non-null, non-array object
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract output content from possibly nested structure, stripping metadata.
 * @param {*} candidate - Output candidate value
 * @returns {*} Extracted output content
 */
function extractOutputContent(candidate) {
  if (!isPlainObject(candidate)) return candidate;

  // Extract nested output, stripping metadata fields
  const {
    output,
    summary,
    error,
    isError,
    diagnostics,
    userInstruction,
    ...rest
  } = candidate;
  return output !== undefined ? output : rest;
}

/**
 * Format output content as display string.
 * @param {*} content - Content to format
 * @returns {string} Formatted display string
 */
function formatOutputText(content) {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  if (isPlainObject(content) && Object.keys(content).length === 0) return '';
  return stringifyWithLanguage(content).text;
}

/**
 * Normalize tool use log entry
 * @param {object} structured - Raw tool use data
 * @returns {object|null} Normalized tool use log
 */
export function normalizeToolUseLog(structured) {
  if (!isPlainObject(structured)) return null;

  const nested = isPlainObject(structured.output) ? structured.output : {};
  const summaryText = firstTrimmed(structured.summary, nested.summary);
  const errorText = firstTrimmed(structured.error, nested.error);
  const userInstructionText = firstTrimmed(
    structured.userInstruction,
    nested.userInstruction,
  );

  const outputContent = extractOutputContent(structured.output);
  const outputText = formatOutputText(outputContent);

  const toolName = trimmedOrNull(structured.toolName ?? structured.tool) ?? '';
  const isUserFeedback = userInstructionText.length > 0;

  return {
    parsed: structured,
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input: structured.input,
    isError: Boolean(structured.isError || nested.isError || errorText),
    isUserFeedback,
    headerSummary: summaryText || (isUserFeedback ? '' : errorText),
  };
}

/**
 * Extract and trim content from normalized payload
 * @param {Object} normalizedPayload - The normalized payload object
 * @returns {{decodedText: string, trimmed: string, isEmpty: boolean}}
 */
export function extractTrimmedContent(normalizedPayload) {
  const decodedText = normalizedPayload?.decodedText || '';
  const trimmed = decodedText.trim();
  return { decodedText, trimmed, isEmpty: !trimmed };
}

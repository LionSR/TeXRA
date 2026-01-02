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
 * Convert a value to a display-friendly string
 * @param {*} value - Value to stringify
 * @returns {string} Display string
 */
export const stringifyForDisplay = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    const yamlString = yaml.stringify(value);
    return typeof yamlString === 'string' ? yamlString.trimEnd() : '';
  } catch (error) {
    return String(value);
  }
};

/**
 * Try to parse a string as JSON
 * @param {string} text - Text to parse
 * @returns {object|null} Parsed JSON or null
 */
export const tryParseJson = (text) => {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
};

/**
 * Normalize structured content from text and data
 * @param {string} text - Raw text content
 * @param {*} data - Optional structured data
 * @returns {{decodedText: string, structured: *}} Normalized payload
 */
export const normalizeStructuredContent = (text, data) => {
  if (data !== undefined) {
    return {
      decodedText: '',
      structured: data,
    };
  }

  // Content is now passed as raw text (no longer HTML-encoded at source)
  const rawText = typeof text === 'string' ? text : '';
  return { decodedText: rawText, structured: tryParseJson(rawText) };
};

/**
 * Normalize file list entries from structured data
 * @param {Array} structured - Raw file list array
 * @returns {Array|null} Normalized file entries or null
 */
export const normalizeFileListEntries = (structured) => {
  if (!Array.isArray(structured)) {
    return null;
  }

  return structured.map((file) => {
    const rawPath = String(file?.path ?? '');
    const source = file?.source || 'unknown';
    const sourceDisplay =
      typeof file?.sourceDisplay === 'string' ? file.sourceDisplay : source;

    return {
      filePath: rawPath,
      fileName: getBasename(rawPath),
      ok: Boolean(file?.ok),
      source,
      sourceDisplay,
      internal: Boolean(file?.internal),
      varName: typeof file?.varName === 'string' ? file.varName : '',
    };
  });
};

/**
 * Normalize missing outputs payload
 * @param {object} structured - Raw missing outputs data
 * @returns {{missing: Array, xmlFile: string|null, documentTag: string|null}|null} Normalized payload
 */
export const normalizeMissingOutputsPayload = (structured) => {
  if (!structured) return null;

  return {
    missing: Array.isArray(structured.missing) ? structured.missing : [],
    xmlFile:
      typeof structured.xmlFile === 'string' && structured.xmlFile
        ? structured.xmlFile
        : null,
    documentTag:
      typeof structured.documentTag === 'string' && structured.documentTag
        ? structured.documentTag
        : null,
  };
};

/**
 * Ensure input is an array for latexdiff entries.
 * Returns the input unchanged if it's an array, null otherwise.
 * Does not validate individual entry structure.
 * @param {*} structured - Input to check
 * @returns {Array|null} Input array or null if not an array
 */
export const ensureLatexdiffArray = (structured) => {
  if (!Array.isArray(structured)) return null;
  return structured;
};

/**
 * Normalize tool use log entry
 * @param {object} structured - Raw tool use data
 * @returns {object|null} Normalized tool use log
 */
export const normalizeToolUseLog = (structured) => {
  if (
    !structured ||
    typeof structured !== 'object' ||
    Array.isArray(structured)
  ) {
    return null;
  }

  const parsed = structured;
  const outputDetails =
    parsed.output && typeof parsed.output === 'object' && parsed.output !== null
      ? parsed.output
      : {};

  const summaryText =
    (typeof parsed.summary === 'string' && parsed.summary.trim()) ||
    (typeof outputDetails.summary === 'string' &&
      outputDetails.summary.trim()) ||
    '';

  const errorText =
    (typeof parsed.error === 'string' && parsed.error.trim()) ||
    (typeof outputDetails.error === 'string' && outputDetails.error.trim()) ||
    '';

  const outputCandidate =
    parsed.output !== undefined ? parsed.output : outputDetails.output;
  const outputText =
    typeof outputCandidate === 'string'
      ? outputCandidate
      : outputCandidate !== undefined
        ? stringifyForDisplay(outputCandidate)
        : '';

  const toolName =
    typeof parsed.toolName === 'string'
      ? parsed.toolName.trim()
      : typeof parsed.tool === 'string'
        ? parsed.tool.trim()
        : '';

  // Extract edited files if present
  const editedFiles = extractEditedFiles(parsed, outputDetails);

  // Extract file path from input for language detection
  const inputFilePath = extractFilePathFromInput(parsed.input);

  return {
    parsed,
    toolName,
    summaryText,
    errorText,
    outputText,
    input: parsed.input,
    inputFilePath,
    editedFiles,
    isError: Boolean(
      parsed.isError || outputDetails.isError || errorText.length > 0,
    ),
    headerSummary: summaryText || errorText,
  };
};

/**
 * Extract file path from tool input for language detection.
 * Checks common property names used by file-related tools.
 * @param {object} input - Tool input object
 * @returns {string|null} File path or null
 */
const extractFilePathFromInput = (input) => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  // Check common property names for file paths
  const pathProps = ['path', 'file_path', 'filePath', 'file', 'filename'];
  for (const prop of pathProps) {
    if (typeof input[prop] === 'string' && input[prop].trim()) {
      return input[prop].trim();
    }
  }

  return null;
};

/**
 * Extract edited files from tool output
 * @param {object} parsed - Parsed tool data
 * @param {object} outputDetails - Output details object
 * @returns {Array} Array of file info objects
 */
const extractEditedFiles = (parsed, outputDetails) => {
  // Check for files in parsed.files (from ToolUseCycleFlow)
  if (Array.isArray(parsed.files) && parsed.files.length > 0) {
    return parsed.files.map(normalizeFileOrEditEntry);
  }

  // Check for edits in output details (from tool result)
  if (Array.isArray(outputDetails.edits) && outputDetails.edits.length > 0) {
    return outputDetails.edits.map(normalizeFileOrEditEntry);
  }

  // Check for files in output details
  if (Array.isArray(outputDetails.files) && outputDetails.files.length > 0) {
    return outputDetails.files.map(normalizeFileOrEditEntry);
  }

  return [];
};

/**
 * Normalize a file or edit entry to a common format.
 * Handles both string paths and objects with path/file properties.
 * @param {object|string} entry - File or edit entry
 * @returns {object} Normalized file info with path, name, and optional line stats
 */
const normalizeFileOrEditEntry = (entry) => {
  if (typeof entry === 'string') {
    return { path: entry, name: getBasename(entry) };
  }
  const path = entry.path || entry.file || '';
  return {
    path,
    name: getBasename(path),
    linesAdded: entry.linesAdded,
    linesRemoved: entry.linesRemoved,
  };
};

/**
 * Extract and trim content from normalized payload
 * @param {Object} normalizedPayload - The normalized payload object
 * @returns {{decodedText: string, trimmed: string, isEmpty: boolean}}
 */
export const extractTrimmedContent = (normalizedPayload) => {
  const decodedText = normalizedPayload?.decodedText || '';
  const trimmed = decodedText.trim();
  return { decodedText, trimmed, isEmpty: !trimmed };
};

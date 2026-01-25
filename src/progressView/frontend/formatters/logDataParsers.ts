/**
 * Data parsing utilities for progress view formatters.
 * Uses Zod schemas as the source of truth for data validation.
 *
 * Provides normalization logic for types that need transformation beyond
 * simple validation (toolUse, fileList). Simpler types like missingOutputs
 * and webSearch use Schema.safeParse(data) directly in formatters.
 */

// Third-party imports
import { z } from 'zod';
import yaml from 'yaml';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Local imports - shared schemas
import { FileListEntrySchema, ToolUseLogSchema } from '@shared/schemas';
import type { NormalizedToolUse, NormalizedFileEntry } from '@shared/schemas';

/** Check if value is a non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Return value if it's a string, otherwise return fallback. */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Normalize file list data into a structured format for rendering.
 * Validates the input array using FileListEntrySchema and transforms
 * entries to include display fields (fileName, filePath).
 *
 * @param data - Raw structured data from the log message
 * @returns Array of normalized file entries, or null if parsing fails
 */
export function normalizeFileListData(
  data: unknown,
): NormalizedFileEntry[] | null {
  // Validate the array structure
  const parseResult = z.array(FileListEntrySchema).safeParse(data);
  if (!parseResult.success) {
    return null;
  }

  // Transform to display format
  return parseResult.data.map((file) => {
    const filePath = file.path;
    const source = file.source ?? 'unknown';

    return {
      // Original fields
      path: filePath,
      ok: file.ok,
      source,
      // Display fields
      filePath,
      fileName: getBasename(filePath),
      sourceDisplay: stringOr(file.sourceDisplay, source),
      internal: file.internal ?? false,
      varName: stringOr(file.varName, ''),
    };
  });
}

/** Return trimmed string if non-empty, null otherwise. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Get first non-empty trimmed string from primary or fallback. */
function firstTrimmed(primary: unknown, fallback: unknown): string {
  return trimmedOrNull(primary) ?? trimmedOrNull(fallback) ?? '';
}

/** Convert a value to a display-friendly string. */
function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    const yamlString = yaml.stringify(value);
    return typeof yamlString === 'string' ? yamlString.trimEnd() : '';
  } catch {
    return String(value);
  }
}

/** Extract output content from possibly nested structure, stripping metadata. */
function extractOutputContent(candidate: unknown): unknown {
  if (!isPlainObject(candidate)) return candidate;

  // Extract nested output, stripping metadata fields
  const {
    output,
    summary: _summary,
    error: _error,
    isError: _isError,
    diagnostics: _diagnostics,
    userInstruction: _userInstruction,
    ...rest
  } = candidate;
  return output !== undefined ? output : rest;
}

/** Format output content as display string. */
function formatOutputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  if (isPlainObject(content) && Object.keys(content).length === 0) return '';
  return stringifyValue(content);
}

/**
 * Normalize raw tool use log data into a structured format for rendering.
 * This is the only complex normalization function needed - it extracts nested
 * fields, computes derived values, and formats output text.
 *
 * @param data - Raw structured data from the log message
 * @returns Normalized tool use data, or null if parsing fails
 */
export function normalizeToolUseData(data: unknown): NormalizedToolUse | null {
  // Validate the basic structure with Zod
  const parseResult = ToolUseLogSchema.safeParse(data);
  if (!parseResult.success) {
    return null;
  }

  // Need to access the raw object for additional fields
  if (!isPlainObject(data)) {
    return null;
  }

  const structured = data as Record<string, unknown>;
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

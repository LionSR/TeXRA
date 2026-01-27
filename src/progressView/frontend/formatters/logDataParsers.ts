/**
 * Data parsing utilities for progress view formatters.
 * Uses Zod schemas as the source of truth for data validation.
 *
 * Provides normalization logic for complex types that need transformation
 * beyond simple validation (toolUse). Simpler types use Schema.safeParse(data)
 * directly in formatters or compute display fields inline in renderers.
 */

// Third-party imports
import yaml from 'yaml';

// Local imports - shared schemas
import { ToolUseLogSchema, type NormalizedToolUse } from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';

// Local imports - shared utilities

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
  // Use explicit undefined check since null is a valid output value
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

  // Use validated data from schema
  const validated = parseResult.data;

  // Extract nested fields from output (may contain summary, error, etc.)
  const nested = isPlainObject(validated.output) ? validated.output : {};

  const summaryText = firstTrimmed(validated.summary, nested.summary);
  const errorText = firstTrimmed(validated.error, nested.error);
  const userInstructionText = firstTrimmed(
    validated.userInstruction,
    nested.userInstruction,
  );

  const outputContent = extractOutputContent(validated.output);
  const outputText = formatOutputText(outputContent);

  const toolName = trimmedOrNull(validated.toolName ?? validated.tool) ?? '';
  const isUserFeedback = userInstructionText.length > 0;

  // Build parsed record for fallback rendering
  // Use original data (not validated) to preserve unknown fields that Zod strips
  const parsed: Record<string, unknown> = isPlainObject(data)
    ? { ...data }
    : { ...validated };

  return {
    parsed,
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input: validated.input,
    isError: Boolean(validated.isError || nested.isError || errorText),
    isUserFeedback,
    headerSummary: summaryText || (isUserFeedback ? '' : errorText),
  };
}

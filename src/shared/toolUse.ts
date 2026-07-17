// Host-neutral normalization for tool-use log payloads.
//
// Both the VS Code progress view and the CLI TUI read the same
// `ToolUseLog` payload off `StreamLogStore.data` and need a flat,
// renderer-friendly view: tool name, derived output text, error/summary
// strings, and the runtime tool status. This module is the
// single entry point for that derivation so hosts don't drift.

import yaml from 'yaml';

import {
  TOOL_USE_STATUS,
  ToolUseLogSchema,
  type NormalizedToolUse,
} from '@shared/schemas';
import { isObject } from '@utils/core';

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstTrimmed(primary: unknown, fallback: unknown): string {
  return trimmedOrNull(primary) ?? trimmedOrNull(fallback) ?? '';
}

function extractOutputContent(candidate: unknown): unknown {
  if (!isObject(candidate)) return candidate;
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

function formatOutputText(content: unknown): string {
  if (typeof content === 'string') return content;
  // `null` must short-circuit alongside `undefined`. yaml.stringify(null)
  // renders the literal string "null", which would surface a spurious
  // output section for tools that return `output: null`.
  if (content === undefined || content === null) return '';
  if (isObject(content) && Object.keys(content).length === 0) return '';
  try {
    const yamlString = yaml.stringify(content);
    return typeof yamlString === 'string' ? yamlString.trimEnd() : '';
  } catch {
    return String(content);
  }
}

export function normalizeToolUseData(data: unknown): NormalizedToolUse | null {
  const parseResult = ToolUseLogSchema.safeParse(data);
  if (!parseResult.success) return null;

  const validated = parseResult.data;
  const nested = isObject(validated.output) ? validated.output : {};

  const summaryText = firstTrimmed(validated.summary, nested.summary);
  const errorText = firstTrimmed(validated.error, nested.error);
  const userInstructionText = firstTrimmed(
    validated.userInstruction,
    nested.userInstruction,
  );

  const outputContent = extractOutputContent(validated.output);
  const outputText = formatOutputText(outputContent);

  const toolName = trimmedOrNull(validated.toolName) ?? '';
  const isUserFeedback = userInstructionText.length > 0;
  const isError = Boolean(
    validated.status === TOOL_USE_STATUS.FAILED ||
    validated.isError ||
    nested.isError ||
    errorText,
  );

  // Preserve unknown fields stripped by the schema for fallback rendering.
  const parsed: Record<string, unknown> = isObject(data)
    ? { ...data }
    : { ...validated };

  return {
    parsed,
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input: validated.input,
    isError,
    isUserFeedback,
    headerSummary: summaryText || (isUserFeedback ? '' : errorText),
    status:
      isError && validated.status === TOOL_USE_STATUS.COMPLETED
        ? TOOL_USE_STATUS.FAILED
        : validated.status,
  };
}

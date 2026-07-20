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

function normalizedExitCode(data: unknown, input: unknown): number | undefined {
  for (const candidate of [data, input]) {
    if (!isObject(candidate)) continue;
    const raw =
      candidate.exitCode ??
      candidate.exit_code ??
      (isObject(candidate.output) ? candidate.output.exitCode : undefined);
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  }
  return undefined;
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

  const exitCode = normalizedExitCode(data, validated.input);

  return {
    toolName,
    errorText,
    outputText,
    ...(exitCode !== undefined ? { exitCode } : {}),
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

// ============================================================================
// Default tool timeouts
// ============================================================================
//
// Shared between the tool implementations and the host UIs that display a
// running-tool countdown (extension/desktop progress view). Keep these here —
// not re-declared per host — so the displayed limit always matches what the
// tool actually enforces.

/** Default `bash` tool timeout (ms) when the model omits `timeout`. */
export const BASH_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

/** Default `executions wait` timeout (seconds) when the model omits `timeout`. */
export const EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS = 300;

/** Minimum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS = 60;

/** Maximum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS = 1800;

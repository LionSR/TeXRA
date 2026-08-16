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
  // yaml.stringify(null) renders the literal string "null", which would
  // surface a spurious output section for tools that return `output: null`.
  if (content == null) return '';
  if (isObject(content) && Object.keys(content).length === 0) return '';
  try {
    return yaml.stringify(content).trimEnd();
  } catch {
    return String(content);
  }
}

/** Matches an exit code stated in prose, e.g. "Command failed (exit 7)" or
 *  "Background bash failed with exit code 2." — the shape delegated
 *  sub-agents and tool error messages use when no structured field exists. */
const EXIT_CODE_PROSE = /\bexit(?: code)?\s+(\d+)\b/i;

function normalizedExitCode(
  data: unknown,
  input: unknown,
  proseText: string,
): number | undefined {
  for (const candidate of [data, input]) {
    if (!isObject(candidate)) continue;
    const raw =
      candidate.exitCode ??
      candidate.exit_code ??
      (isObject(candidate.output) ? candidate.output.exitCode : undefined);
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }
  // Last resort: some emitters (delegated sub-agents, background bash
  // delivery) state the exit code only in their error/summary prose. Derive
  // it here, once, so renderers never scan output text themselves.
  const match = EXIT_CODE_PROSE.exec(proseText);
  return match ? Number(match[1]) : undefined;
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

  const headerSummary = summaryText || (isUserFeedback ? '' : errorText);
  const exitCode = normalizedExitCode(
    data,
    validated.input,
    [errorText, headerSummary, outputText].join('\n'),
  );

  return {
    toolName,
    errorText,
    outputText,
    ...(exitCode !== undefined ? { exitCode } : {}),
    userInstructionText,
    input: validated.input,
    isError,
    isUserFeedback,
    headerSummary,
    status:
      isError && validated.status === TOOL_USE_STATUS.COMPLETED
        ? TOOL_USE_STATUS.FAILED
        : validated.status,
  };
}

/**
 * Visible failure text both hosts render when a `toolUse` payload cannot be
 * parsed. Kept beside {@link normalizeToolUseData} so the CLI and progress
 * view can't drift on the wording of the shared malformed-payload policy.
 */
const MALFORMED_TOOL_USE_TEXT = 'Malformed tool payload';

/**
 * Host-neutral fallback for a `toolUse` row whose payload `safeParse` fails.
 * Both renderers substitute this normalized view instead of dropping the row
 * (CLI) or falling through to the default log template (webview). The raw
 * payload is retained as `input` so a non-object value still has a visible
 * body; unknown tool names and unstructured object outputs never reach this
 * path because they still parse through {@link ToolUseLogSchema}.
 */
export function malformedToolUseFallback(data: unknown): NormalizedToolUse {
  return {
    toolName: '',
    errorText: MALFORMED_TOOL_USE_TEXT,
    outputText: '',
    userInstructionText: '',
    input: data,
    isError: true,
    isUserFeedback: false,
    headerSummary: MALFORMED_TOOL_USE_TEXT,
    status: TOOL_USE_STATUS.FAILED,
  };
}

// ============================================================================
// Shared tool limits
// ============================================================================
//
// Shared between the tool implementations and the host UIs that display a
// running-tool countdown (extension/desktop progress view). Keep these here —
// not re-declared per host — so the displayed limit always matches what the
// tool actually enforces.

/** Default `bash` tool timeout (ms) when the model omits `timeout`. */
export const BASH_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Max chars a background `bash` run logs to its child stream before it stops
 * logging and writes a single truncation notice. Lives here because the writer
 * (`tools/bash.ts`) and the reader (`/executions/{id}/output`) must agree on
 * the figure the output header reports.
 */
export const BASH_BACKGROUND_LOG_CAP_CHARS = 200_000;

const BASH_BACKGROUND_OUTPUT_SOURCE_KEY = 'backgroundBashOutputSource';
export type BackgroundBashOutputSource = 'stdout' | 'stderr';

/** Metadata attached only to stdout/stderr chunks from background `bash`. */
export function backgroundBashOutputData(
  source: BackgroundBashOutputSource,
): Record<string, BackgroundBashOutputSource> {
  return { [BASH_BACKGROUND_OUTPUT_SOURCE_KEY]: source };
}

/** Identify persisted LOG rows written from background command output chunks. */
export function getBackgroundBashOutputSource(
  data: unknown,
): BackgroundBashOutputSource | undefined {
  if (!isObject(data)) return undefined;
  const source = data[BASH_BACKGROUND_OUTPUT_SOURCE_KEY];
  return source === 'stdout' || source === 'stderr' ? source : undefined;
}

/** Default `executions wait` timeout (seconds) when the model omits `timeout`. */
export const EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS = 300;

/** Minimum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS = 60;

/** Maximum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS = 1800;

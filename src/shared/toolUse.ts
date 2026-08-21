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
  type ToolUseStatus,
} from '@shared/schemas';
import { clamp, isObject } from '@utils/core';
import { truncateSummary } from '@utils/text/stringUtils';

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
  let serialized: string;
  try {
    serialized = yaml.stringify(content);
  } catch {
    // Tool output is an untyped provider/plugin payload, and YAML may reject
    // cyclic or custom values. Only that serializer boundary is caught; this
    // display fallback cannot hide tool execution or application logic failures.
    return String(content);
  }
  return serialized.trimEnd();
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
    ...(validated.spillPath ? { spillPath: validated.spillPath } : {}),
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

const TOOL_USE_STATUS_VALUES = new Set<string>(Object.values(TOOL_USE_STATUS));

/** Recover a source-owned status without accepting an invalid enum member. */
function validSourceToolUseStatus(data: unknown): ToolUseStatus | undefined {
  if (!isObject(data)) return undefined;
  const status = data.status;
  return typeof status === 'string' && TOOL_USE_STATUS_VALUES.has(status)
    ? (status as ToolUseStatus)
    : undefined;
}

/**
 * Bounded, value-safe reason for a failed `toolUse` parse. Primitive payloads
 * get a short type/preview; object payloads report only the invalid field
 * *paths*, never field values, so a partially valid `read`/`bash` row cannot
 * leak its full output into the diagnostic.
 */
function malformedToolUseDiagnostic(data: unknown): string {
  const reason = isObject(data)
    ? malformedObjectReason(data)
    : malformedPrimitiveReason(data);
  return truncateSummary(`${MALFORMED_TOOL_USE_TEXT} (${reason})`, 160);
}

function malformedObjectReason(data: Record<string, unknown>): string {
  const parsed = ToolUseLogSchema.safeParse(data);
  if (parsed.success) return 'unparseable payload';
  const fields = [
    ...new Set(
      parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .filter((path) => path.length > 0),
    ),
  ];
  return fields.length > 0
    ? `invalid ${fields.join(', ')}`
    : 'unparseable payload';
}

function malformedPrimitiveReason(data: unknown): string {
  if (data === null) return 'received null';
  if (typeof data === 'string') {
    return `received string ${JSON.stringify(truncateSummary(data, 40))}`;
  }
  if (typeof data === 'number') return `received number ${data}`;
  if (typeof data === 'boolean') return `received boolean ${data}`;
  if (Array.isArray(data)) return `received array of length ${data.length}`;
  return `received ${typeof data}`;
}

/**
 * Single render-boundary normalization shared by both hosts. A parse failure
 * becomes a visible failed tool row instead of being dropped (CLI) or falling
 * through to the default log template (webview).
 *
 * The fallback keeps the row live unless the source itself carries a valid
 * terminal `status`, so a temporarily malformed in-progress row can still be
 * replaced by a later corrected payload in the append-only transcript. It
 * preserves only independently usable fields (`toolName` when a string,
 * `input` from `data.input`) and keeps the bounded diagnostic out of the
 * normal tool input/output sections. Unknown tool names and unstructured
 * object outputs never reach the fallback because they still parse through
 * {@link ToolUseLogSchema}.
 */
export function normalizeToolUseForRender(data: unknown): NormalizedToolUse {
  return normalizeToolUseData(data) ?? malformedToolUseFallback(data);
}

function malformedToolUseFallback(data: unknown): NormalizedToolUse {
  const diagnostic = malformedToolUseDiagnostic(data);
  const status = validSourceToolUseStatus(data);
  return {
    toolName:
      isObject(data) && typeof data.toolName === 'string' ? data.toolName : '',
    errorText: diagnostic,
    outputText: '',
    userInstructionText: '',
    input: isObject(data) && 'input' in data ? data.input : undefined,
    isError: true,
    isUserFeedback: false,
    headerSummary: diagnostic,
    ...(status !== undefined ? { status } : {}),
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

/**
 * The `executions wait` timeout the tool will actually honour, in seconds.
 * Sole owner of the clamp: the tool's own input schema normalizes through it,
 * and both transcript surfaces read it back so no host can invent a different
 * number than the one the wait enforces.
 */
export function executionsWaitTimeoutSeconds(timeout: unknown): number {
  return typeof timeout === 'number' && Number.isFinite(timeout)
    ? clamp(
        timeout,
        EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
        EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
      )
    : EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS;
}

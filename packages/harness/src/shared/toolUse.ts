// Host-neutral normalization for tool-use log payloads.
//
// Both the VS Code progress view and the CLI TUI read the same
// `ToolUseLog` payload off a transcript entry's `data` and need a flat,
// renderer-friendly view: tool name, derived output text, error/summary
// strings, and the runtime tool status. This module is the
// single entry point for that derivation so hosts don't drift.

import yaml from 'yaml';

import {
  TOOL_CALL_STATUS,
  ToolUseLogSchema,
  type NormalizedToolUse,
  type ToolUseLog,
} from '@shared/schemas';
import { clamp, isObject } from '@utils/core';
import { truncateSummary } from '@utils/text/stringUtils';
import type { z } from 'zod';

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstTrimmed(primary: unknown, fallback: unknown): string {
  return trimmedOrNull(primary) ?? trimmedOrNull(fallback) ?? '';
}

/** Fields of a tool result that are its metadata, not its output: each is
 *  shown on its own (the header summary, the error, the user's instruction)
 *  or deliberately not shown (diagnostics). */
export const TOOL_RESULT_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'summary',
  'error',
  'diagnostics',
  'userInstruction',
]);

function extractOutputContent(candidate: unknown): unknown {
  if (!isObject(candidate)) return candidate;
  if (candidate.output !== undefined) return candidate.output;
  return Object.fromEntries(
    Object.entries(candidate).filter(
      ([field]) =>
        field !== 'output' && !TOOL_RESULT_METADATA_FIELDS.has(field),
    ),
  );
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

/** The flat, renderer-friendly view of a decoded tool-use payload. */
export function normalizeToolUse(log: ToolUseLog): NormalizedToolUse {
  const nested = isObject(log.output) ? log.output : {};

  const summaryText = firstTrimmed(log.summary, nested.summary);
  const errorText = firstTrimmed(log.error, nested.error);
  const userInstructionText = firstTrimmed(
    log.userInstruction,
    nested.userInstruction,
  );

  const outputContent = extractOutputContent(log.output);
  const outputText = formatOutputText(outputContent);

  const toolName = trimmedOrNull(log.toolName) ?? '';
  const isUserFeedback = userInstructionText.length > 0;

  const headerSummary = summaryText || (isUserFeedback ? '' : errorText);

  return {
    toolName,
    errorText,
    outputText,
    ...(log.exitCode !== undefined ? { exitCode: log.exitCode } : {}),
    userInstructionText,
    input: log.input,
    isUserFeedback,
    headerSummary,
    status: log.status,
  };
}

/**
 * Visible failure text both hosts render when a `toolUse` payload cannot be
 * parsed. Kept beside {@link decodeToolUseLog} so the CLI and progress view
 * can't drift on the wording of the shared malformed-payload policy.
 */
const MALFORMED_TOOL_USE_TEXT = 'Malformed tool payload';

/**
 * Bounded, value-safe reason for a failed `toolUse` parse. Object payloads
 * report only the invalid field *paths*, never field values, so a partially
 * valid `read`/`bash` row cannot leak its full output into the diagnostic.
 */
function malformedToolUseDiagnostic(
  issues: readonly z.core.$ZodIssue[],
): string {
  const fields = [
    ...new Set(
      issues
        .map((issue) => issue.path.join('.'))
        .filter((path) => path.length > 0),
    ),
  ];
  const reason =
    fields.length > 0 ? `invalid ${fields.join(', ')}` : 'unparseable payload';
  return truncateSummary(`${MALFORMED_TOOL_USE_TEXT} (${reason})`, 160);
}

/**
 * Decode a tool card's payload once, at the transcript fold. Fields outside
 * {@link ToolUseLogSchema} (e.g. `toolUseDispatch.ts`'s `files`) are kept. A
 * payload the schema rejects becomes a visible failed card rather than being
 * dropped: it keeps only the independently usable fields (`toolName` when a
 * string, `input`) and carries the bounded diagnostic as its error. It stays
 * live only while the source itself says the call is in progress, so a later
 * corrected payload can still replace it; anything else reads as failed
 * rather than as a quiet success.
 */
export function decodeToolUseLog(data: Record<string, unknown>): ToolUseLog {
  const parsed = ToolUseLogSchema.loose().safeParse(data);
  if (parsed.success) return parsed.data;
  return {
    ...(typeof data.toolName === 'string' ? { toolName: data.toolName } : {}),
    ...('input' in data ? { input: data.input } : {}),
    error: malformedToolUseDiagnostic(parsed.error.issues),
    status:
      data.status === TOOL_CALL_STATUS.IN_PROGRESS
        ? TOOL_CALL_STATUS.IN_PROGRESS
        : TOOL_CALL_STATUS.FAILED,
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

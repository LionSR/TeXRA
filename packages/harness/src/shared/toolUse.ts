// Host-neutral normalization for tool cards.
//
// Both the VS Code progress view and the CLI TUI read the same tool card
// (`ToolCallLog`) off a transcript row: this module derives the texts a card
// states and its output, once, so hosts don't drift.

import { Number as Num, Predicate, Record as EffectRecord } from 'effect';

import type { FinishedToolResult, ToolCallLog } from '@shared/schemas';
import { stringifyPayload } from '@shared/transcript/transcriptText';
import { formatCount } from '@utils/text/stringUtils';

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
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

/** A stored result's fields as its card reads them: without the `status`
 *  the card states, and without a key left `undefined`. */
function resultFields(result: FinishedToolResult): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([field, value]) => field !== 'status' && value !== undefined,
    ),
  );
}

/** What a stored result shows as its output: its `output`, else its fields
 *  but the ones shown on their own. */
function storedOutput(result: FinishedToolResult): unknown {
  if (result.status === 'executed' && result.output !== undefined)
    return result.output;
  return EffectRecord.filter(
    resultFields(result),
    (_, field) => !TOOL_RESULT_METADATA_FIELDS.has(field),
  );
}

/** A tool's output as text: an empty object shows no output section. */
function formatOutputText(content: unknown): string {
  if (Predicate.isObject(content) && Object.keys(content).length === 0)
    return '';
  return stringifyPayload(content).text.full;
}

/** The texts a call states beside its output, trimmed: from its stored
 *  result when it has one, else from what its tool stated. A call the user
 *  rejected or redirected leads with no error: the error is their own. */
export function toolCallTexts(log: ToolCallLog): {
  errorText: string;
  userInstructionText: string;
  isUserFeedback: boolean;
  headerSummary: string;
} {
  const { result } = log;
  const summaryText = trimmed(result ? result.summary : log.summary);
  const errorText = trimmed(
    result ? (result.status === 'error' ? result.error : undefined) : log.error,
  );
  const userInstructionText = trimmed(
    result ? result.userInstruction : log.userInstruction,
  );
  const isUserFeedback = userInstructionText.length > 0;
  return {
    errorText,
    userInstructionText,
    isUserFeedback,
    headerSummary: summaryText || (isUserFeedback ? '' : errorText),
  };
}

/** A call's output: `parsed` as its structured sections read it (MCP
 *  content blocks, edit start lines, per-file line changes), the stored
 *  result's fields when it has one, and `text` as the output block shows it. */
export function toolCallOutput(log: ToolCallLog): {
  parsed: unknown;
  text: string;
} {
  const { result } = log;
  return result === undefined
    ? { parsed: log.output, text: formatOutputText(log.output) }
    : {
        parsed: resultFields(result),
        text: formatOutputText(storedOutput(result)),
      };
}

// ============================================================================
// Shared tool limits
// ============================================================================
//
// Shared between the tool implementations and the transcript's tool row
// model, which states a running call's limit (`ToolRowModel.timeoutMs`), so
// the displayed limit always matches what the tool actually enforces.

/** Default `bash` tool timeout (ms) when the model omits `timeout`. */
export const BASH_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Max chars a background `bash` run records as `process.output` rows as
 * they arrive, both streams together. Past it the run writes a truncation
 * notice; a stream still records up to the delivery's head budget, and the
 * rest is held back. When the command ends each stream's held-back tail is
 * recorded as a row marking the gap before it (`elided`), so a capped log
 * holds at most one head and one tail per stream beyond this figure. Lives
 * here because the writer (`tools/bash.ts`) and the reader
 * (`/executions/{id}/output`) must agree on the figure the output header
 * reports.
 */
export const BASH_BACKGROUND_LOG_CAP_CHARS = 200_000;

/** The note an excerpt shows where it left `elided` characters out: of a
 *  tool result, of a command's `stream`, or where a capped process log left
 *  part of a stream out. */
export const elidedNote = (elided: number, stream?: string): string =>
  `[... ${formatCount(elided)} characters elided${stream === undefined ? '' : ` from ${stream}`} ...]`;

/**
 * The lines a stored file-viewing call asked for (`read_file`'s `range`, the
 * memory and executions tools' `view_range`), read from its input as the
 * model wrote it: `{start, end}` or `[start, end]`, either end possibly
 * absent.
 */
export function lineRangeOf(value: unknown): {
  readonly start?: number;
  readonly end?: number;
} {
  const [start, end] = Array.isArray(value)
    ? [value[0], value[1]]
    : Predicate.isObject(value)
      ? [value.start, value.end]
      : [];
  return {
    ...(typeof start === 'number' ? { start } : {}),
    ...(typeof end === 'number' ? { end } : {}),
  };
}

/** Default `executions wait` timeout (seconds) when the model omits `timeout`. */
export const EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS = 300;

/** Minimum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS = 60;

/** Maximum `executions wait` timeout (seconds). */
export const EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS = 1800;

/**
 * The `executions wait` timeout the tool honours, in seconds: `timeout`
 * clamped to [{@link EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS},
 * {@link EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS}], or
 * {@link EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS} when it is not a finite
 * number.
 */
export function executionsWaitTimeoutSeconds(timeout: unknown): number {
  return typeof timeout === 'number' && Number.isFinite(timeout)
    ? Num.clamp(timeout, {
        minimum: EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
        maximum: EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
      })
    : EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS;
}

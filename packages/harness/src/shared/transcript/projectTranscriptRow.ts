/**
 * The transcript row builders: what each thing a run says looks like as the
 * row every host paints. The transcript fold decides which builder an event reaches and supplies the row envelope; these
 * turn typed, already-decoded values into rows and never parse.
 *
 * Membership for a decoded `log` payload is a single allowlist: every message
 * type either produces a row or is explicitly decided against in
 * {@link logPayloadRow}, and the switch is exhaustive over its payloads, so
 * adding one fails to compile rather than silently missing from a host. Row
 * density (one-liner or expanded card) is a paint-time choice; it is never
 * expressed by withholding a row.
 */
import {
  MESSAGE_TYPES,
  type ErrorLogData,
  modelFailureMessage,
  reasonPhrase,
  type FileListEntry,
  type LogPayload,
  type ToolCallLog,
} from '@shared/schemas';
import { normalizeToolUse, resultFields } from '@shared/toolUse';
import { formatCompactTokenCount } from '@utils/text/stringUtils';

import { toolRowModel, type ToolRowModelContext } from './toolRowModel';
import { transcriptText } from './transcriptText';
import {
  ERROR_DETAIL_KEYS,
  type ErrorDetailKey,
  type ErrorRow,
  type ErrorRowDetail,
  type LogRow,
  type StatItem,
  type StreamingTextRow,
  type ToolRow,
  type TranscriptRow,
  type TranscriptRowBase,
} from './transcriptRow';

// ---------------------------------------------------------------------------
// Text rows
// ---------------------------------------------------------------------------

/** A plain log row, or no row when the text is blank. */
export function plainLogRow(
  base: TranscriptRowBase,
  text: string,
): LogRow | undefined {
  const measured = transcriptText(text);
  if (!measured.oneLine.trim()) return undefined;
  return { ...base, kind: 'log', text: measured };
}

/** Model text or thinking; no row while the text is blank. */
export function streamingTextRow(
  base: TranscriptRowBase,
  kind: StreamingTextRow['kind'],
  text: string,
  streaming: boolean,
  cut?: StreamingTextRow['cut'],
): StreamingTextRow | undefined {
  const measured = transcriptText(text);
  if (!measured.oneLine.trim()) return undefined;
  return {
    ...base,
    kind,
    text: measured,
    streaming,
    ...(cut === undefined ? {} : { cut }),
  };
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * An error's detail fields, by key: a model failure's from its verdict (its
 * plain words, provider, status and request id), any other failure's from
 * its own words.
 *
 * `partialText` is deliberately absent: it is a retry surface's material,
 * not a transcript row's. `RetryRequestPanel` reads it from the approval
 * request's own payload, never from a projected row.
 */
function errorFields(
  data: ErrorLogData,
): Partial<Record<ErrorDetailKey, string | number>> {
  const { failure, operation, model } = data;
  const where = { operation, model };
  if (failure === undefined)
    return { message: data.message, ...where, rawMessage: data.rawMessage };
  const status = failure.source === 'model' ? failure.status : undefined;
  return {
    message: modelFailureMessage(failure),
    ...where,
    provider: failure.provider,
    statusCode: status,
    statusText: status === undefined ? undefined : reasonPhrase(status),
    requestId: failure.source === 'model' ? failure.requestId : undefined,
  };
}

function errorDetails(
  data: ErrorLogData | undefined,
  summary: string,
): ErrorRowDetail[] {
  if (!data) return [];
  const fields = errorFields(data);
  return ERROR_DETAIL_KEYS.flatMap((key) => {
    const value = fields[key];
    // The message is the summary on most failures; repeating it under the
    // summary says nothing.
    if (value == null || (key === 'message' && value === summary)) return [];
    const text = String(value);
    return text.trim() === '' ? [] : [{ key, value: text }];
  });
}

function errorRow(
  base: TranscriptRowBase,
  summary: string,
  data: ErrorLogData | undefined,
): ErrorRow {
  return {
    ...base,
    kind: 'error',
    // An error logged with no words still reads as one, on every host.
    summary: transcriptText(summary.trim() === '' ? 'Error occurred' : summary),
    details: errorDetails(data, summary),
    ...(data?.failure !== undefined && { failure: data.failure }),
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function fileListSummary(files: readonly FileListEntry[]): string {
  const loaded = files.filter((file) => file.ok).length;
  const failed = files.length - loaded;
  const failedSuffix = failed > 0 ? `, ${failed} not found` : '';
  return `Files (${loaded}/${files.length} loaded${failedSuffix})`;
}

/** The entries as a host lists them: a file that did not load, or names no
 *  path, shows no media label. */
function listedFiles(files: readonly FileListEntry[]): FileListEntry[] {
  return files.map(({ media, ...file }) =>
    file.ok && media && file.path.trim() ? { ...file, media } : file,
  );
}

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

const CONTEXT_MANAGEMENT_LABEL: Readonly<Record<string, string>> = {
  clear_tool_uses: 'Cleared tool uses',
  clear_thinking: 'Cleared thinking',
  truncation: 'Truncated',
  max_tokens_reduced: 'Max tokens reduced',
};

const TOKENS_FREED_ACTIONS = new Set(['clear_tool_uses', 'clear_thinking']);

/**
 * A `max_tokens_reduced` event whose adjusted ceiling is still this high is a
 * minor housekeeping detail, not something to interrupt a reader with.
 */
const MAX_TOKENS_REDUCED_DISPLAY_THRESHOLD = 32_768;

// ---------------------------------------------------------------------------
// Tool and script-call rows
// ---------------------------------------------------------------------------

/** What a tool row says of its call beyond its payload, as the transcript
 *  fold holds it: from the card's `tool.start`, a script's call's section and
 *  attempt; from the run, a cut by its end. */
export type ToolCallFacts = Pick<
  ToolRow,
  'section' | 'attempt' | 'cutByRunEnd'
>;

/** A tool card from its decoded payload; `output` is the live text a running
 *  card printed, which paints in place of the durable output, and `call` is
 *  what its slot holds beyond the payload, which every repaint carries. */
export function toolRow(
  base: TranscriptRowBase,
  log: ToolCallLog,
  output: string | undefined,
  runLabels: ToolRowModelContext['runLabels'],
  call: ToolCallFacts,
): ToolRow {
  const { result: _result, ...stated } = log;
  const shown: ToolCallLog = output === undefined ? log : { ...stated, output };
  return {
    ...base,
    ...call,
    kind: 'tool',
    model: toolRowModel(normalizeToolUse(shown), {
      ...(runLabels ? { runLabels } : {}),
      parsedOutput:
        shown.result === undefined ? shown.output : resultFields(shown.result),
    }),
    log,
  };
}

// ---------------------------------------------------------------------------
// Log payload rows
// ---------------------------------------------------------------------------

/** The decoded `log` payloads the fold routes here: every one but the
 *  streaming text and tool payloads, which it keeps open. */
export type LogRowPayload = Exclude<
  LogPayload,
  {
    messageType:
      | typeof MESSAGE_TYPES.MODEL_RESPONSE
      | typeof MESSAGE_TYPES.THINKING
      | typeof MESSAGE_TYPES.TOOL_USE;
  }
>;

export function logPayloadRow(
  base: TranscriptRowBase,
  text: string,
  payload: LogRowPayload,
  forkAt?: number,
): TranscriptRow | undefined {
  switch (payload.messageType) {
    case MESSAGE_TYPES.USER_MESSAGE: {
      return {
        ...base,
        kind: 'user',
        text: transcriptText(text),
        ...(payload.data?.scriptSummary
          ? { scriptSummary: payload.data.scriptSummary }
          : {}),
        attachments: payload.data?.attachments ?? [],
        media: payload.data?.media ?? [],
        ...(forkAt === undefined ? {} : { forkAt }),
      };
    }

    case MESSAGE_TYPES.ERROR:
      return errorRow(base, text, payload.data);

    case MESSAGE_TYPES.WEB_SEARCH: {
      const { query } = payload.data;
      return {
        ...base,
        kind: 'webSearch',
        ...(query !== undefined ? { query } : {}),
      };
    }

    case MESSAGE_TYPES.FILE_LIST: {
      const files = payload.data;
      if (files.length === 0) return undefined;
      return {
        ...base,
        kind: 'fileList',
        files: listedFiles(files),
        summary: fileListSummary(files),
      };
    }

    case MESSAGE_TYPES.CONTEXT_MANAGEMENT: {
      const data = payload.data;
      const reduced = data.action === 'max_tokens_reduced';
      if (
        reduced &&
        data.reducedMaxTokens >= MAX_TOKENS_REDUCED_DISPLAY_THRESHOLD
      ) {
        return undefined;
      }
      const items: StatItem[] = [];
      if (reduced) {
        items.push({
          key: 'maxTokens',
          label: 'Max tokens reduced',
          value: `${formatCompactTokenCount(data.originalMaxTokens)} → ${formatCompactTokenCount(data.reducedMaxTokens)}`,
        });
      } else if (TOKENS_FREED_ACTIONS.has(data.action)) {
        const freed = data.tokensBefore - data.tokensAfter;
        if (freed > 0) {
          items.push({
            key: 'tokensFreed',
            label: 'Tokens freed',
            value: formatCompactTokenCount(freed),
          });
        }
      }
      const before = `${data.utilizationBefore.toFixed(1)}%`;
      items.push({
        key: 'utilization',
        label: 'Context utilization',
        value: reduced
          ? before
          : `${before} → ${data.utilizationAfter.toFixed(1)}%`,
      });
      items.push({
        key: 'contextWindow',
        label: 'Context window',
        value: formatCompactTokenCount(data.contextWindow),
      });
      if (data.details) {
        items.push({ key: 'details', label: 'Details', value: data.details });
      }
      return {
        ...base,
        kind: 'contextManagement',
        data,
        label: CONTEXT_MANAGEMENT_LABEL[data.action] ?? 'Context management',
        items,
      };
    }

    case MESSAGE_TYPES.PROGRESS_STATUS:
      return {
        ...base,
        kind: 'progressStatus',
        summary: transcriptText(text.trim() || 'Status update'),
      };

    case MESSAGE_TYPES.DEFAULT:
      return plainLogRow(base, text);

    // ── No row ──────────────────────────────────────────────────────────
    // A compaction lifecycle row is not a row of its own: the correlated
    // block the fold projects from several of them is, via
    // `compactionActivityRow`.
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
      return undefined;

    default:
      // A persisted payload can carry a messageType this build does not
      // know, so the failure names it.
      payload satisfies never;
      throw new Error(`Unprojected log payload: ${JSON.stringify(payload)}`);
  }
}

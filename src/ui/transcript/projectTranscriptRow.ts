/**
 * The transcript row builders: what each thing a run says looks like as the
 * row every host paints. The transcript fold (`@shared/session/transcriptFold`)
 * decides which builder an event reaches and supplies the row envelope; these
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
  workflowCallStatusLabel,
  type ErrorLogData,
  type ExtendedTokenUsageStats,
  type FileListEntry,
  type LogPayload,
  type ToolUseLog,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { getModelLabel } from '@shared/model/modelLabel';
import { normalizeToolUse } from '@shared/toolUse';
import {
  hasIncompleteEmbeddedSubagentFollowup,
  summarizeFollowupMessage,
} from '@shared/subagentFollowup';
import {
  formatWorkflowCallLine,
  formatWorkflowCallMetadataParts,
  formatWorkflowPhaseHeading,
  workflowCallDetail,
} from '@ui/copy/workflowCall';
import { assertNever } from '@utils/core';
import {
  formatCompactTokenCount,
  formatCostUsd,
} from '@utils/text/stringUtils';

import { toolRowModel, type ToolRowModelContext } from './toolRowModel';
import { stringifyPayload, transcriptText } from './transcriptText';
import type {
  ErrorRow,
  ErrorRowDetail,
  LoadedMediaRef,
  LogRow,
  PhaseRow,
  StatItem,
  StreamingTextRow,
  ToolRow,
  TranscriptRow,
  TranscriptRowBase,
  WorkflowTaskRow,
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

/** Model text, thinking, or scratchpad; no row while the text is blank. */
export function streamingTextRow(
  base: TranscriptRowBase,
  kind: StreamingTextRow['kind'],
  text: string,
  streaming: boolean,
): StreamingTextRow | undefined {
  const measured = transcriptText(text);
  if (!measured.oneLine.trim()) return undefined;
  return {
    ...base,
    kind,
    text: measured,
    streaming,
    ...(kind === 'assistant' &&
    hasIncompleteEmbeddedSubagentFollowup(measured.full)
      ? { pendingEmbeddedFollowup: true }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * The canonical error detail set, in display order. Typed against
 * `ErrorLogData` so a schema rename is a compile error here rather than a
 * field that quietly stops rendering.
 *
 * `partialText` is deliberately absent: it is a retry surface's material,
 * not a transcript row's. `RetryRequestPanel` reads it from the approval
 * request's own payload, never from a projected row. So is `userRetryable`:
 * the runtime's retry routing flag, which the row's own retry affordance
 * already expresses to a reader.
 */
const ERROR_DETAIL_FIELDS = [
  'message',
  'operation',
  'model',
  'provider',
  'statusCode',
  'statusText',
  'classification',
  'requestId',
  'rawMessage',
] as const satisfies readonly (keyof ErrorLogData)[];

function errorDetails(
  data: ErrorLogData | undefined,
  summary: string,
): ErrorRowDetail[] {
  if (!data) return [];
  return ERROR_DETAIL_FIELDS.flatMap((key) => {
    const value = data[key];
    // The message is the summary on most failures; repeating it under the
    // summary says nothing. Neither does an empty provider body.
    if (value == null || (key === 'message' && value === summary)) return [];
    const text =
      typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
    if (text.trim() === '' || text === '{}') return [];
    return [{ key, value: text }];
  });
}

function errorRow(
  base: TranscriptRowBase,
  summary: string,
  data: ErrorLogData | undefined,
): ErrorRow {
  const details = errorDetails(data, summary);
  return {
    ...base,
    kind: 'error',
    summary: transcriptText(summary),
    details,
    detailText: transcriptText(
      details.map((detail) => `${detail.key}: ${detail.value}`).join('\n'),
    ),
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

function loadedMedia(files: readonly FileListEntry[]): LoadedMediaRef[] {
  return files.flatMap((file) =>
    file.ok && file.media && file.path.trim()
      ? [{ path: file.path, media: file.media }]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Statistics / context management
// ---------------------------------------------------------------------------

type NumericStatKey = {
  [K in keyof ExtendedTokenUsageStats]-?: NonNullable<
    ExtendedTokenUsageStats[K]
  > extends number
    ? K
    : never;
}[keyof ExtendedTokenUsageStats];

const STAT_FIELDS: readonly (readonly [
  key: NumericStatKey,
  label: string,
  format: (value: number) => string,
])[] = [
  ['inputTokens', 'Input tokens', formatCompactTokenCount],
  ['outputTokens', 'Output tokens', formatCompactTokenCount],
  ['cacheReadInputTokens', 'Cache hits', formatCompactTokenCount],
  ['cacheMissInputTokens', 'Cache misses', formatCompactTokenCount],
  ['cacheCreationInputTokens', 'Cache writes', formatCompactTokenCount],
  ['percentageCached', 'Cached %', (value) => `${value.toFixed(2)}%`],
  ['reasoningTokens', 'Reasoning tokens', formatCompactTokenCount],
  ['toolUseTokens', 'Tool tokens', formatCompactTokenCount],
  ['elapsedTime', 'Elapsed time', (value) => `${value}s`],
  ['cost', 'Cost', formatCostUsd],
];

function statisticsItems(stats: Partial<ExtendedTokenUsageStats>): StatItem[] {
  return STAT_FIELDS.flatMap(([key, label, format]) => {
    const value = stats[key];
    return value === undefined ? [] : [{ key, label, value: format(value) }];
  });
}

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
// Phase, tool, and workflow-call rows
// ---------------------------------------------------------------------------

/** A workflow phase header, the row a script writes per `phase()`; no row
 *  when the label is blank. */
export function phaseRow(
  base: TranscriptRowBase,
  phaseLabel: string,
  phaseIndex: number | undefined,
  phaseTotal: number | undefined,
): PhaseRow | undefined {
  if (phaseLabel.trim().length === 0) return undefined;
  return {
    ...base,
    kind: 'phase',
    heading: formatWorkflowPhaseHeading({
      phaseLabel,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(phaseTotal !== undefined ? { phaseTotal } : {}),
    }),
    phaseLabel,
    ...(phaseIndex !== undefined ? { phaseIndex } : {}),
    ...(phaseTotal !== undefined ? { phaseTotal } : {}),
  };
}

/** A tool card from its decoded payload; `output` is the live text a running
 *  card printed, which paints in place of the durable output. */
export function toolRow(
  base: TranscriptRowBase,
  log: ToolUseLog,
  output: string | undefined,
  runLabels: ToolRowModelContext['runLabels'],
): ToolRow {
  const shown = output === undefined ? log : { ...log, output };
  const toolUse = normalizeToolUse(shown);
  return {
    ...base,
    kind: 'tool',
    toolUse,
    model: toolRowModel(toolUse, {
      ...(runLabels ? { runLabels } : {}),
      parsedOutput: shown.output,
    }),
    log,
  };
}

export function workflowTaskRow(
  base: TranscriptRowBase,
  progress: WorkflowCallProgress,
): WorkflowTaskRow {
  const call =
    progress.model === undefined
      ? progress
      : { ...progress, model: getModelLabel(progress.model) };
  const detail = workflowCallDetail(call);
  return {
    ...base,
    kind: 'workflowTask',
    call,
    line: formatWorkflowCallLine(call),
    statusLabel: workflowCallStatusLabel(call),
    metadataParts: formatWorkflowCallMetadataParts(call),
    ...(detail ? { detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Log payload rows
// ---------------------------------------------------------------------------

/** The decoded `log` payloads the fold routes here: every one but the
 *  streaming text, tool, and workflow-call payloads, which it keeps open. */
export type LogRowPayload = Exclude<
  LogPayload,
  {
    messageType:
      | typeof MESSAGE_TYPES.MODEL_RESPONSE
      | typeof MESSAGE_TYPES.THINKING
      | typeof MESSAGE_TYPES.SCRATCHPAD
      | typeof MESSAGE_TYPES.TOOL_USE
      | typeof MESSAGE_TYPES.WORKFLOW_TASK;
  }
>;

export function logPayloadRow(
  base: TranscriptRowBase,
  text: string,
  payload: LogRowPayload,
): TranscriptRow | undefined {
  switch (payload.messageType) {
    case MESSAGE_TYPES.USER_MESSAGE: {
      const measured = transcriptText(text);
      return {
        ...base,
        kind: 'user',
        text: measured,
        summary: transcriptText(summarizeFollowupMessage(measured.full)),
        ...(payload.data?.workflowSummary
          ? { workflowSummary: payload.data.workflowSummary }
          : {}),
        ...(payload.data?.attachments
          ? { attachments: payload.data.attachments }
          : {}),
      };
    }

    case MESSAGE_TYPES.ERROR:
      return errorRow(base, text, payload.data);

    case MESSAGE_TYPES.WEB_SEARCH: {
      const { query } = payload.data;
      return {
        ...base,
        kind: 'webSearch',
        label: `Web Search${query ? `: "${query}"` : ''}`,
        ...(query !== undefined ? { query } : {}),
      };
    }

    case MESSAGE_TYPES.FILE_LIST: {
      const files = payload.data;
      if (files.length === 0) return undefined;
      return {
        ...base,
        kind: 'fileList',
        files,
        summary: fileListSummary(files),
        media: loadedMedia(files),
      };
    }

    case MESSAGE_TYPES.MISSING_OUTPUTS: {
      const { missing, xmlFile } = payload.data;
      if (missing.length === 0 && !xmlFile) return undefined;
      return {
        ...base,
        kind: 'missingOutputs',
        missing,
        xmlFile,
        summary: `Missing outputs (${missing.length})`,
      };
    }

    case MESSAGE_TYPES.LATEXDIFF: {
      const entries = payload.data;
      if (entries.length === 0) return undefined;
      const runId = entries.find((item) => item.runId)?.runId;
      return {
        ...base,
        kind: 'latexdiff',
        entries,
        ...(runId ? { runId } : {}),
      };
    }

    case MESSAGE_TYPES.STATISTICS: {
      const items = statisticsItems(payload.data);
      if (items.length === 0) return undefined;
      return { ...base, kind: 'statistics', label: 'Statistics', items };
    }

    case MESSAGE_TYPES.CONTEXT_MANAGEMENT: {
      const data = payload.data;
      // A client compaction is one row, its activity, which carries these
      // figures (`compactionActivityRow`); a second row would repeat it.
      if (data.action === 'compaction') return undefined;
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
        ...(data.summary ? { summary: transcriptText(data.summary) } : {}),
      };
    }

    case MESSAGE_TYPES.PROGRESS_STATUS: {
      const detail = stringifyPayload(payload.data).text;
      return {
        ...base,
        kind: 'progressStatus',
        summary: transcriptText(text.trim() || 'Status update'),
        ...(detail.full ? { detail } : {}),
      };
    }

    case MESSAGE_TYPES.DEFAULT:
      return plainLogRow(base, text);

    // ── No row ──────────────────────────────────────────────────────────
    // A compaction lifecycle row is not a row of its own: the correlated
    // block the fold projects from several of them is, via
    // `compactionActivityRow`. `activeSkills` is a per-run snapshot read on
    // demand from the log (the CLI's `/status`), not a transcript row, and
    // `internal` is a durable marker nothing renders. Context utilization is
    // a status surface on both hosts, read off `RunView.context`, so it has
    // no transcript row either.
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
    case MESSAGE_TYPES.ACTIVE_SKILLS:
    case MESSAGE_TYPES.CONTEXT_STATE:
    case MESSAGE_TYPES.INTERNAL:
      return undefined;

    default:
      return assertNever(
        payload,
        `Unprojected log messageType: ${String((payload as LogPayload).messageType)}`,
      );
  }
}

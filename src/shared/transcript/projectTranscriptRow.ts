/**
 * The one projection from a stream-log entry to a transcript row.
 *
 * Membership is a single allowlist: every message type either produces a row
 * or is explicitly decided against here, and the switch is exhaustive over
 * `MessageType`, so adding one fails to compile rather than silently missing
 * from a host. Row density — one-liner or expanded card — is a paint-time
 * choice; it is never expressed by withholding a row.
 */
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  WORKFLOW_TASK_STATUS_LABEL,
  parseDiffResultEntries,
  type ErrorLogData,
  type ExtendedTokenUsageStats,
  type FileListEntry,
  type StreamLogEntry,
} from '@shared/schemas';
import { normalizeToolUseForRender } from '@shared/toolUse';
import {
  deliveryTagOf,
  hasIncompleteEmbeddedSubagentFollowup,
  summarizeFollowupMessage,
} from '@shared/subagentFollowup';
import {
  formatWorkflowCallLine,
  formatWorkflowCallMetadataParts,
  formatWorkflowPhaseHeading,
  workflowCallDetail,
} from '@shared/copy/workflowCall';
import { assertNever, isObject, tryParseUrl } from '@utils/core';
import {
  formatCompactTokenCount,
  formatCostUsd,
} from '@utils/text/stringUtils';

import { toolRowModel, type ToolRowModelContext } from './toolRowModel';
import {
  stringifyPayload,
  transcriptText,
  type TranscriptText,
} from './transcriptText';
import type {
  ErrorRow,
  ErrorRowDetail,
  LoadedMediaRef,
  StatItem,
  StreamingTextRow,
  TranscriptRow,
  TranscriptRowBase,
} from './transcriptRow';

export interface TranscriptRowContext {
  /** The row previously projected for this slot. Consulted for exactly one
   *  thing: a phase's `GROUP_END` carries no index/total, so the counts the
   *  `GROUP_START` established are inherited rather than dropped. */
  readonly previousRow?: TranscriptRow;
  /** The host paints this stream's task-group surface, so run/round/session
   *  lifecycle headings belong there and not in the transcript. True on every
   *  stream in the progress view; the CLI clears it only for a full-log child
   *  that is not a workflow run (a detached process, an external-CLI session),
   *  which has no task-group renderer and whose verbatim log is the point of
   *  opening it. Phase headers are unaffected — they stay transcript rows
   *  everywhere. */
  readonly projectLifecycleToTaskGroups?: boolean;
  /** Subagent execution id -> label, for the `executions` tool header. */
  readonly executionLabels?: ToolRowModelContext['executionLabels'];
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function spillPathOf(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  return typeof data.spillPath === 'string' ? data.spillPath : undefined;
}

function rowBase(entry: StreamLogEntry): TranscriptRowBase {
  const spillPath = spillPathOf(entry.data);
  return {
    id: entry.id,
    seqNo: entry.seqNo,
    timestamp: entry.timestamp,
    level: entry.level,
    ...(entry.settlementSeqNo !== undefined
      ? { settlementSeqNo: entry.settlementSeqNo }
      : {}),
    ...(entry.verbose !== undefined ? { verbose: entry.verbose } : {}),
    ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
    ...(entry.messageType ? { messageType: entry.messageType } : {}),
    ...(spillPath ? { spillPath } : {}),
  };
}

function entryText(entry: StreamLogEntry): TranscriptText {
  return transcriptText(entry.text ?? '');
}

function isStreamingPayload(data: unknown): boolean {
  return isObject(data) && data.status === 'running';
}

/** The three message types whose payload is streaming markdown text. */
const STREAMING_TEXT_ROW_KIND = {
  [MESSAGE_TYPES.MODEL_RESPONSE]: 'assistant',
  [MESSAGE_TYPES.THINKING]: 'thinking',
  [MESSAGE_TYPES.SCRATCHPAD]: 'scratchpad',
} as const satisfies Record<string, StreamingTextRow['kind']>;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * The canonical error detail set, in display order. Typed against
 * `ErrorLogData` so a schema rename is a compile error here rather than a
 * field that quietly stops rendering.
 *
 * `streamDiagnostics` and `partialText` are deliberately absent: they are a
 * retry surface's material, not a transcript row's, and both remain reachable
 * through `ErrorRow.data`.
 */
const ERROR_DETAIL_FIELDS = [
  'message',
  'operation',
  'model',
  'provider',
  'statusCode',
  'statusText',
  'userRetryable',
  'exhaustionReason',
  'missingApiKey',
  'contextWindow',
  'requestId',
  'rawMessage',
  'rawErrorBody',
] as const satisfies readonly (keyof ErrorLogData)[];

function errorDetails(
  data: ErrorLogData | undefined,
  summary: string,
): ErrorRowDetail[] {
  if (!data) return [];
  const details: ErrorRowDetail[] = [];
  for (const key of ERROR_DETAIL_FIELDS) {
    const value = data[key];
    if (value == null) continue;
    // The message is the summary on most failures; repeating it under the
    // summary says nothing.
    if (key === 'message' && value === summary) continue;
    details.push({
      key,
      value:
        typeof value === 'object'
          ? JSON.stringify(value, null, 2)
          : String(value),
    });
  }
  return details;
}

function projectErrorRow(
  entry: StreamLogEntry & { messageType: typeof MESSAGE_TYPES.ERROR },
): ErrorRow {
  const data = entry.data;
  const summary = entry.text ?? '';
  const details = errorDetails(data, summary);
  return {
    ...rowBase(entry),
    kind: 'error',
    summary: transcriptText(summary),
    ...(data ? { data } : {}),
    details,
    detailText: transcriptText(
      details.map((detail) => `${detail.key}: ${detail.value}`).join('\n'),
    ),
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function fileListSummary(files: readonly FileListEntry[]): {
  summary: string;
  counts: { loaded: number; failed: number; total: number };
} {
  const loaded = files.filter((file) => file.ok).length;
  const failed = files.length - loaded;
  const failedSuffix = failed > 0 ? `, ${failed} not found` : '';
  return {
    summary: `Files (${loaded}/${files.length} loaded${failedSuffix})`,
    counts: { loaded, failed, total: files.length },
  };
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
  compaction: 'Compacted',
  clear_tool_uses: 'Cleared tool uses',
  clear_thinking: 'Cleared thinking',
  truncation: 'Truncated',
  max_tokens_reduced: 'Max tokens reduced',
};

const TOKENS_FREED_ACTIONS = new Set([
  'clear_tool_uses',
  'clear_thinking',
  'compaction',
]);

/**
 * A `max_tokens_reduced` event whose adjusted ceiling is still this high is a
 * minor housekeeping detail, not something to interrupt a reader with.
 */
const MAX_TOKENS_REDUCED_DISPLAY_THRESHOLD = 32_768;

// ---------------------------------------------------------------------------
// Web tools
// ---------------------------------------------------------------------------

const WEB_SEARCH_PROVIDER_LABEL: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

const WEB_SEARCH_STATUS_SUFFIX: Readonly<Record<string, string>> = {
  in_progress: ' (searching...)',
  failed: ' (failed)',
};

const WEB_FETCH_ERROR_LABEL: Readonly<Record<string, string>> = {
  invalid_tool_input: 'Invalid URL format',
  url_too_long: 'URL exceeds maximum length',
  url_not_allowed: 'URL blocked by domain filter',
  url_not_accessible: 'Failed to access URL',
  unsupported_content_type: 'Unsupported content type',
  too_many_requests: 'Rate limit exceeded',
  max_uses_exceeded: 'Maximum fetch uses exceeded',
  unavailable: 'Service unavailable',
};

// ---------------------------------------------------------------------------
// Phase / group rows
// ---------------------------------------------------------------------------

/**
 * A phase header — the rows a workflow script emits per `phase()`, recorded
 * as `GROUP_START` and upserted in place to `GROUP_END`. Detected by `kind`,
 * not by entry type, so the header keeps its identity after the phase closes.
 */
function phaseGroupData(
  entry: StreamLogEntry,
): { index?: number; total?: number; attemptId?: string } | undefined {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END
  ) {
    return undefined;
  }
  const { kind, index, total, attemptId } = entry.data;
  if (kind !== 'phase') return undefined;
  return {
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function projectTranscriptRow(
  entry: StreamLogEntry,
  ctx: TranscriptRowContext = {},
): TranscriptRow | undefined {
  const phase = phaseGroupData(entry);
  if (phase) {
    const phaseLabel = entry.text ?? '';
    if (phaseLabel.trim().length === 0) return undefined;
    // A closing phase row carries no counts of its own; inherit the ones the
    // opening row established so `(2/3)` does not vanish when a phase ends.
    const previous =
      ctx.previousRow?.kind === 'phase' ? ctx.previousRow : undefined;
    const phaseIndex = phase.index ?? previous?.phaseIndex;
    const phaseTotal = phase.total ?? previous?.phaseTotal;
    return {
      ...rowBase(entry),
      kind: 'phase',
      heading: formatWorkflowPhaseHeading({
        phaseLabel,
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(phaseTotal !== undefined ? { phaseTotal } : {}),
      }),
      phaseLabel,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(phaseTotal !== undefined ? { phaseTotal } : {}),
      ...(phase.attemptId !== undefined ? { attemptId: phase.attemptId } : {}),
    };
  }

  if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) {
    if (ctx.projectLifecycleToTaskGroups) return undefined;
    const text = entryText(entry);
    if (!text.oneLine.trim()) return undefined;
    return { ...rowBase(entry), kind: 'log', text };
  }

  const messageType = entry.messageType;
  if (messageType === undefined) {
    const text = entryText(entry);
    if (!text.oneLine.trim()) return undefined;
    return { ...rowBase(entry), kind: 'log', text };
  }

  switch (messageType) {
    case MESSAGE_TYPES.MODEL_RESPONSE:
    case MESSAGE_TYPES.THINKING:
    case MESSAGE_TYPES.SCRATCHPAD: {
      const text = entryText(entry);
      if (!text.oneLine.trim()) return undefined;
      const kind = STREAMING_TEXT_ROW_KIND[messageType];
      return {
        ...rowBase(entry),
        kind,
        text,
        streaming: isStreamingPayload(entry.data),
        ...(kind === 'assistant' &&
        hasIncompleteEmbeddedSubagentFollowup(text.full)
          ? { pendingEmbeddedFollowup: true }
          : {}),
      };
    }

    case MESSAGE_TYPES.USER_MESSAGE: {
      const text = entryText(entry);
      const tag = deliveryTagOf(text.full);
      return {
        ...rowBase(entry),
        kind: 'user',
        text,
        summary: transcriptText(summarizeFollowupMessage(text.full)),
        ...(tag ? { deliveryTag: tag } : {}),
        ...(entry.data?.workflowSummary
          ? { workflowSummary: entry.data.workflowSummary }
          : {}),
        ...(entry.data?.attachments
          ? { attachments: entry.data.attachments }
          : {}),
      };
    }

    case MESSAGE_TYPES.ERROR:
      return projectErrorRow(entry);

    case MESSAGE_TYPES.TOOL_USE: {
      // A malformed payload becomes a visible failed tool row rather than
      // vanishing: the shared normalizer owns that policy for both hosts.
      const toolUse = normalizeToolUseForRender(entry.data);
      return {
        ...rowBase(entry),
        kind: 'tool',
        toolUse,
        model: toolRowModel(toolUse, {
          ...(ctx.executionLabels
            ? { executionLabels: ctx.executionLabels }
            : {}),
          parsedOutput: entry.data.output,
        }),
        ...(toolUse.spillPath ? { spillPath: toolUse.spillPath } : {}),
      };
    }

    case MESSAGE_TYPES.WEB_SEARCH: {
      const { query, results, provider, status } = entry.data;
      const providerLabel =
        WEB_SEARCH_PROVIDER_LABEL[provider ?? 'web'] ?? 'Web';
      const suffix = WEB_SEARCH_STATUS_SUFFIX[status ?? ''] ?? '';
      return {
        ...rowBase(entry),
        kind: 'webSearch',
        label: `${providerLabel} Search${query ? `: "${query}"` : ''}${suffix}`,
        ...(query !== undefined ? { query } : {}),
        results: results ?? [],
        ...(provider !== undefined ? { provider } : {}),
        ...(status !== undefined ? { status } : {}),
        failed: status === 'failed',
        inProgress: status === 'in_progress',
      };
    }

    case MESSAGE_TYPES.WEB_FETCH: {
      const { url, title, status, errorCode, content } = entry.data;
      const failed = status === 'failed';
      const host = url ? (tryParseUrl(url)?.hostname ?? url) : '';
      const errorLabel =
        failed && errorCode
          ? (WEB_FETCH_ERROR_LABEL[errorCode] ?? errorCode)
          : undefined;
      return {
        ...rowBase(entry),
        kind: 'webFetch',
        label: `Web Fetch${host ? `: ${host}` : ''}${failed ? ' (failed)' : ''}`,
        ...(url !== undefined ? { url } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(errorLabel !== undefined ? { errorLabel } : {}),
        ...(content ? { content: transcriptText(content) } : {}),
        failed,
      };
    }

    case MESSAGE_TYPES.FILE_LIST: {
      const files = entry.data;
      if (files.length === 0) return undefined;
      const { summary, counts } = fileListSummary(files);
      return {
        ...rowBase(entry),
        kind: 'fileList',
        category: entry.text ?? '',
        files,
        counts,
        summary,
        media: loadedMedia(files),
      };
    }

    case MESSAGE_TYPES.MISSING_OUTPUTS: {
      const { missing, xmlFile } = entry.data;
      if (missing.length === 0 && !xmlFile) return undefined;
      return {
        ...rowBase(entry),
        kind: 'missingOutputs',
        missing,
        xmlFile,
        summary: `Missing outputs (${missing.length})`,
      };
    }

    case MESSAGE_TYPES.LATEXDIFF: {
      const entries = parseDiffResultEntries(entry.data);
      if (entries.length === 0) return undefined;
      const runId = entries.find((item) => item.runId)?.runId;
      return {
        ...rowBase(entry),
        kind: 'latexdiff',
        entries,
        ...(runId ? { runId } : {}),
      };
    }

    case MESSAGE_TYPES.STATISTICS: {
      const items = statisticsItems(entry.data);
      if (items.length === 0) return undefined;
      return {
        ...rowBase(entry),
        kind: 'statistics',
        stats: entry.data,
        items,
      };
    }

    case MESSAGE_TYPES.CONTEXT_MANAGEMENT: {
      const data = entry.data;
      if (
        data.action === 'max_tokens_reduced' &&
        data.reducedMaxTokens >= MAX_TOKENS_REDUCED_DISPLAY_THRESHOLD
      ) {
        return undefined;
      }
      const items: StatItem[] = [];
      if (data.action === 'max_tokens_reduced') {
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
        value:
          data.action === 'max_tokens_reduced'
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
        ...rowBase(entry),
        kind: 'contextManagement',
        data,
        label: CONTEXT_MANAGEMENT_LABEL[data.action] ?? 'Context management',
        items,
        ...(data.summary ? { summary: transcriptText(data.summary) } : {}),
      };
    }

    case MESSAGE_TYPES.CONTEXT_STATE:
      return { ...rowBase(entry), kind: 'contextState', data: entry.data };

    case MESSAGE_TYPES.PROGRESS_STATUS: {
      const detail = stringifyPayload(entry.data).text;
      return {
        ...rowBase(entry),
        kind: 'progressStatus',
        summary: transcriptText((entry.text ?? '').trim() || 'Status update'),
        ...(detail.full ? { detail } : {}),
      };
    }

    case MESSAGE_TYPES.WORKFLOW_TASK: {
      const call = entry.data;
      const detail = workflowCallDetail(call);
      return {
        ...rowBase(entry),
        kind: 'workflowTask',
        call,
        line: formatWorkflowCallLine(call),
        statusLabel: WORKFLOW_TASK_STATUS_LABEL[call.status],
        metadataParts: formatWorkflowCallMetadataParts(call),
        ...(detail ? { detail } : {}),
      };
    }

    case MESSAGE_TYPES.DEFAULT: {
      const text = entryText(entry);
      if (!text.oneLine.trim()) return undefined;
      return { ...rowBase(entry), kind: 'log', text };
    }

    // ── No row ──────────────────────────────────────────────────────────
    // A compaction lifecycle row is not a row of its own: the correlated
    // block a stream projects from several of them is, via
    // `compactionActivityRow`. `activeSkills` is stream state, and
    // `internal` is a durable marker (the workflow-attempt boundary) that
    // nothing renders.
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
    case MESSAGE_TYPES.ACTIVE_SKILLS:
    case MESSAGE_TYPES.INTERNAL:
      return undefined;

    default:
      return assertNever(
        messageType,
        `Unprojected stream-log messageType: ${String(messageType)}`,
      );
  }
}

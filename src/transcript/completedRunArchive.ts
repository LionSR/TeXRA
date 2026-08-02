/**
 * Completed-run archive reads (#7246 Decision 1): once a run finishes, its
 * durable display/export data is owned by the transcript sidecars
 * (`streamLogs/{stream}.json` + `streamData/{stream}/*`), keyed through the
 * execution→stream mapping. The legacy `executions/{id}/conversation.json` /
 * `todos.json` KV projections are READ-ONLY fallbacks for runs recorded
 * before the sidecars existed. Each fact keeps exactly one legacy read arm,
 * here, tracked for D3 retirement in the #6981 ledger.
 */
import { isDeepStrictEqual } from 'node:util';

import { getExecutionStore, type TodoEntry } from '@agent/storage';
import { mediaAttachmentKindToContentBlock } from '@agent/export/attachmentMarkerVocabulary';
import { formatToolResultAsText } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import {
  formatConversationMessage,
  stringifyConversationValue,
} from '@agent/storage/conversationFormat';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  ToolUseLogSchema,
  UserMessagePayloadSchema,
  WebFetchPayloadSchema,
  WebSearchPayloadSchema,
  type ExecutionId,
  type StreamLogEntry,
  type StreamTabId,
  type TodoItem,
  type ToolUseLog,
} from '@shared/schemas';
import { ToolResultSchema } from '@shared/schemas/toolResult';
import { assertNever, generateShortId, isObject } from '@utils/core';

import {
  findPersistedStreamFallbacksForExecution,
  resolvePersistedStreamIdForExecution,
  type PersistedStreamIdResolution,
} from './executionStreamResolver';
import { StreamLogStore } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';

type CompletedRunTodosSource = 'streamData' | 'legacyKV' | 'none';

export interface CompletedRunTodosReadResult {
  readonly todos: TodoEntry[];
  readonly source: CompletedRunTodosSource;
  readonly streamId?: StreamTabId;
}

function todoItemToEntry(todo: TodoItem): TodoEntry {
  return {
    content: todo.content,
    status: todo.status,
  };
}

async function readLegacyTodos(
  executionId: ExecutionId,
): Promise<CompletedRunTodosReadResult> {
  const todos = await getExecutionStore(executionId).readTodos();
  return {
    todos,
    source: todos.length > 0 ? 'legacyKV' : 'none',
  };
}

/**
 * Read the archived task list for a completed run, preferring the durable
 * stream sidecar (`streamData/{stream}/workPlan.json`), with
 * `executions/{id}/todos.json` as a read-only fallback for historical runs.
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
  });

  if (
    resolved &&
    (await snapshotStore.hasPersistedWorkPlan(resolved.streamId))
  ) {
    const snapshot = await snapshotStore.read(resolved.streamId);
    return {
      todos: snapshot.todos.map(todoItemToEntry),
      source: 'streamData',
      streamId: resolved.streamId,
    };
  }
  return readLegacyTodos(executionId);
}

// ============================================================================
// Conversation
// ============================================================================

type CompletedRunConversationSource = 'streamLog' | 'legacyKV' | 'none';

export interface CompletedRunConversationReadResult {
  /** Provider-agnostic `{role, content}` messages, or `null` when neither
   *  source holds any conversation data. */
  readonly conversation: unknown[] | null;
  readonly source: CompletedRunConversationSource;
  readonly streamId?: StreamTabId;
  /** Sidecars admitted to the selected stream's consistent linear history. */
  readonly streamIds?: readonly StreamTabId[];
  /** Historical candidates rejected because their persisted rows do not
   *  establish one consistent continuation of the selected stream. */
  readonly diagnostics?: readonly CompletedRunArchiveDiagnostic[];
}

export type CompletedRunArchiveDiagnostic =
  | {
      readonly kind: 'disconnectedStream';
      readonly streamId: StreamTabId;
    }
  | {
      readonly kind: 'conflictingRow';
      readonly streamId: StreamTabId;
      readonly rowId: string;
    }
  | {
      readonly kind: 'orderingCycle';
      readonly streamId: StreamTabId;
    }
  | {
      readonly kind: 'branchingHistory';
      readonly streamId: StreamTabId;
    };

/**
 * Deliberate non-goal (#7508): image blocks inside a tool result are not
 * reconstructed here. `ToolUseLog.output` carries either historical display
 * text or the attachment-stripped `ToolResult` fields; attachment bytes never
 * reach the transcript row. Unlike the web-fetch page-content case, there's
 * no existing size-capped/marker-only slot for this in the export pipeline
 * (`ExportNode`'s `tool-result` kind is `{text}` only), and reconstructing one
 * would mean threading attachment bytes through `tool.end` just to summarize
 * them — out of scope here.
 */
function toolResultText(tool: ToolUseLog): string | undefined {
  if (tool.error !== undefined) return tool.error;
  if (typeof tool.output === 'string') return tool.output;
  if (isObject(tool.output)) {
    const result = ToolResultSchema.safeParse({
      ...tool.output,
      status: tool.isError ? 'error' : 'executed',
    });
    if (result.success) return formatToolResultAsText(result.data);
  }
  if (tool.output !== undefined) return stringifyConversationValue(tool.output);
  return tool.summary;
}

/**
 * `userMessage` rows may carry an attachment-kind/count payload (#7508) —
 * media that was sent to the model but only ever lived in the provider
 * message. When present, render `content` as Anthropic-shaped blocks (no
 * bytes) via the attachment-marker vocabulary constructor, so
 * `normalizeConversationForExport` renders them as `[image attachment]` or
 * `[document attachment]`; otherwise keep the plain-string
 * `content` shape every other conversation consumer already expects. This
 * module holds no independent opinion on what those blocks look like.
 */
function userMessageEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text) return [];
  const parsed = UserMessagePayloadSchema.safeParse(entry.data);
  const attachments = parsed.success ? (parsed.data.attachments ?? []) : [];
  const role = archivedConversationRole(entry, 'user');
  if (attachments.length === 0) {
    return [{ role, content: entry.text }];
  }
  return [
    {
      role,
      content: [
        { type: 'text', text: entry.text },
        ...attachments.map(mediaAttachmentKindToContentBlock),
      ],
    },
  ];
}

function modelResponseEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [
    {
      role: archivedConversationRole(entry, 'assistant'),
      content: [{ type: 'text', text: entry.text }],
    },
  ];
}

function archivedConversationRole(
  entry: StreamLogEntry,
  fallback: string,
): string {
  const data = isObject(entry.data) ? entry.data : {};
  return typeof data.archivedRole === 'string' ? data.archivedRole : fallback;
}

function thinkingEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: entry.text }],
    },
  ];
}

function toolUseEntryToMessages(entry: StreamLogEntry): unknown[] {
  const parsed = ToolUseLogSchema.safeParse(entry.data);
  if (!parsed.success) return [];
  const tool = parsed.data;
  const messages: unknown[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: tool.toolName ?? 'unknown',
          input: tool.input ?? {},
        },
      ],
    },
  ];
  const resultText = toolResultText(tool);
  if (resultText !== undefined) {
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', content: resultText }],
    });
  }
  return messages;
}

/** Anthropic-shaped `server_tool_use` + `web_search_tool_result` blocks. */
function webSearchEntryToMessages(entry: StreamLogEntry): unknown[] {
  const parsed = WebSearchPayloadSchema.safeParse(entry.data);
  if (!parsed.success) return [];
  const blocks: unknown[] = [];
  if (parsed.data.query) {
    blocks.push({
      type: 'server_tool_use',
      name: 'web_search',
      input: { query: parsed.data.query },
    });
  }
  const results = (parsed.data.results ?? [])
    .filter((result) => result.url)
    .map((result) => ({
      type: 'web_search_result',
      url: result.url,
      title: result.title ?? result.url,
    }));
  if (results.length > 0) {
    blocks.push({ type: 'web_search_tool_result', content: results });
  }
  return blocks.length > 0 ? [{ role: 'assistant', content: blocks }] : [];
}

function webFetchEntryToMessages(entry: StreamLogEntry): unknown[] {
  const parsed = WebFetchPayloadSchema.safeParse(entry.data);
  if (!parsed.success || !parsed.data.url) return [];
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'web_fetch_tool_result',
          url: parsed.data.url,
          ...(parsed.data.title !== undefined && { title: parsed.data.title }),
          // `page_content` is the field name normalizeConversationForExport's
          // ContentBlockSchema already recognizes for this block type (#7508).
          ...(parsed.data.content !== undefined && {
            page_content: parsed.data.content,
          }),
        },
      ],
    },
  ];
}

/**
 * Map one transcript row to conversation messages. Exhaustive over the
 * {@link MessageType} union — the transcript is the single completed-run
 * record, so every entry kind must carry an explicit map-or-skip decision
 * here; adding a new `MessageType` without deciding fails to compile
 * (`assertNever`), instead of silently dropping conversation content.
 */
function conversationMessagesForEntry(entry: StreamLogEntry): unknown[] {
  const { messageType } = entry;
  if (messageType === undefined) return [];
  switch (messageType) {
    // ── Conversation content ────────────────────────────────────────────
    case MESSAGE_TYPES.USER_MESSAGE:
      return userMessageEntryToMessages(entry);
    case MESSAGE_TYPES.MODEL_RESPONSE:
      return modelResponseEntryToMessages(entry);
    case MESSAGE_TYPES.THINKING:
      return thinkingEntryToMessages(entry);
    case MESSAGE_TYPES.TOOL_USE:
      return toolUseEntryToMessages(entry);
    case MESSAGE_TYPES.WEB_SEARCH:
      return webSearchEntryToMessages(entry);
    case MESSAGE_TYPES.WEB_FETCH:
      return webFetchEntryToMessages(entry);
    // ── Deliberately skipped: not conversation content ──────────────────
    // scratchpad is a derived view carved from the modelResponse raw text
    // (already mapped above); the rest are run diagnostics/status rows that
    // the legacy conversation.json projection never contained either.
    case MESSAGE_TYPES.SCRATCHPAD:
    case MESSAGE_TYPES.FILE_LIST:
    case MESSAGE_TYPES.MISSING_OUTPUTS:
    case MESSAGE_TYPES.LATEXDIFF:
    case MESSAGE_TYPES.STATISTICS:
    case MESSAGE_TYPES.PROGRESS_STATUS:
    case MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY:
    case MESSAGE_TYPES.ERROR:
    case MESSAGE_TYPES.INTERNAL:
    case MESSAGE_TYPES.CONTEXT_MANAGEMENT:
    case MESSAGE_TYPES.CONTEXT_STATE:
    case MESSAGE_TYPES.WORKFLOW_TASK:
    case MESSAGE_TYPES.DEFAULT:
      return [];
    default:
      return assertNever(
        messageType,
        `Unmapped stream-log messageType: ${String(messageType)}`,
      );
  }
}

/**
 * Reconstruct a provider-agnostic conversation from persisted transcript
 * rows. Uses the Anthropic-style content-block vocabulary (`text`,
 * `thinking`, `tool_use`/`tool_result`, `server_tool_use`,
 * `web_search_tool_result`, `web_fetch_tool_result`) that every existing
 * conversation consumer (`@agent/storage/conversationFormat`, the
 * chat-export normalizer, the CLI workspace-file extractor) already
 * recognizes, so downstream rendering code needs no new shape.
 */
function streamLogEntriesToConversation(
  entries: readonly StreamLogEntry[],
): unknown[] {
  return entries.flatMap((entry) =>
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG
      ? conversationMessagesForEntry(entry)
      : [],
  );
}

/**
 * Import a pre-sidecar persisted conversation into an otherwise
 * conversation-empty stream before a resumed reflection run appends new
 * turns. This is the one legacy-to-canonical migration boundary: subsequent
 * completed reads remain sidecar-first and never have to splice two histories.
 */
export async function seedResumedConversationSidecar(
  streamLogStore: StreamLogStore,
  streamId: StreamTabId,
  executionId: ExecutionId,
  messages: readonly unknown[],
): Promise<boolean> {
  if (messages.length === 0) return false;
  await streamLogStore.ensureLoaded(streamId);
  const existing = streamLogStore.get(streamId);
  if (
    existing &&
    streamLogEntriesToConversation(existing.toJSON()).length > 0
  ) {
    return false;
  }

  const normalized = messages
    .map((message) => formatConversationMessage(message))
    .filter(({ content }) => content.length > 0);
  if (normalized.length === 0) return false;

  const writer = streamLogStore.acquireWriter(streamId, executionId);
  try {
    for (const { role, content } of normalized) {
      writer.appendSettled({
        id: generateShortId(),
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: 'info',
        timestamp: Date.now(),
        messageType:
          role === 'assistant' || role === 'model'
            ? MESSAGE_TYPES.MODEL_RESPONSE
            : MESSAGE_TYPES.USER_MESSAGE,
        text: content,
        data: { archivedRole: role },
        verbose: false,
      });
    }
  } finally {
    writer.close();
  }
  return true;
}

/** Reconstruct one stream's conversation; `[]` when the log is absent/empty. */
async function conversationFromStream(
  streamLogStore: StreamLogStore,
  streamId: StreamTabId,
): Promise<unknown[]> {
  await streamLogStore.ensureLoaded(streamId);
  const log = streamLogStore.get(streamId);
  return log ? streamLogEntriesToConversation(log.toJSON()) : [];
}

interface ArchiveMergeResult {
  readonly conversation: unknown[];
  readonly streamIds: readonly StreamTabId[];
  readonly diagnostics: readonly CompletedRunArchiveDiagnostic[];
}

function entriesAgree(left: StreamLogEntry, right: StreamLogEntry): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.level === right.level &&
    left.timestamp === right.timestamp &&
    left.groupId === right.groupId &&
    left.messageType === right.messageType &&
    left.text === right.text &&
    left.verbose === right.verbose &&
    isDeepStrictEqual(left.data, right.data)
  );
}

/**
 * Decide whether a candidate and the currently admitted chronology describe
 * one linear history. Their common rows must occupy the same contiguous
 * interval after alignment. Thus a suffix may continue into a prefix (in
 * either direction), and a contained historical prefix is harmless, while
 * two continuations that fork after a copied row are rejected.
 */
function isSingleContinuation(
  admitted: readonly StreamLogEntry[],
  candidate: readonly StreamLogEntry[],
): boolean {
  const admittedIndexById = new Map(
    admitted.map((entry, index) => [entry.id, index]),
  );
  const firstCandidateOverlap = candidate.findIndex((entry) =>
    admittedIndexById.has(entry.id),
  );
  if (firstCandidateOverlap === -1) return false;
  const firstAdmittedOverlap = admittedIndexById.get(
    candidate[firstCandidateOverlap]!.id,
  )!;
  const offset = firstAdmittedOverlap - firstCandidateOverlap;
  return candidate.every((entry, candidateIndex) => {
    const admittedIndex = candidateIndex + offset;
    return (
      admittedIndex < 0 ||
      admittedIndex >= admitted.length ||
      admitted[admittedIndex]?.id === entry.id
    );
  });
}

function orderMergedEntries(
  entriesByStream: readonly (readonly StreamLogEntry[])[],
): StreamLogEntry[] | null {
  const nodes = new Map<
    string,
    { readonly entry: StreamLogEntry; readonly streamIndex: number }
  >();
  const successors = new Map<string, Set<string>>();
  const indegrees = new Map<string, number>();
  for (const [streamIndex, entries] of entriesByStream.entries()) {
    let previousId: string | undefined;
    for (const entry of entries) {
      if (!nodes.has(entry.id)) nodes.set(entry.id, { entry, streamIndex });
      if (!indegrees.has(entry.id)) indegrees.set(entry.id, 0);
      if (previousId && previousId !== entry.id) {
        const nextIds = successors.get(previousId) ?? new Set<string>();
        if (!nextIds.has(entry.id)) {
          nextIds.add(entry.id);
          successors.set(previousId, nextIds);
          indegrees.set(entry.id, (indegrees.get(entry.id) ?? 0) + 1);
        }
      }
      previousId = entry.id;
    }
  }

  const remaining = new Set(nodes.keys());
  const ready = new Set(
    [...remaining].filter((id) => (indegrees.get(id) ?? 0) === 0),
  );
  const ordered: StreamLogEntry[] = [];
  while (ready.size > 0) {
    let nextId: string | undefined;
    for (const id of ready) {
      const candidate = nodes.get(id);
      const next = nextId ? nodes.get(nextId) : undefined;
      if (
        candidate &&
        (!next ||
          candidate.entry.timestamp < next.entry.timestamp ||
          (candidate.entry.timestamp === next.entry.timestamp &&
            (candidate.streamIndex < next.streamIndex ||
              (candidate.streamIndex === next.streamIndex &&
                candidate.entry.seqNo < next.entry.seqNo))))
      ) {
        nextId = id;
      }
    }
    if (!nextId) break;
    const next = nodes.get(nextId);
    if (!next) break;
    ordered.push(next.entry);
    ready.delete(nextId);
    remaining.delete(nextId);
    for (const successorId of successors.get(nextId) ?? []) {
      const indegree = (indegrees.get(successorId) ?? 0) - 1;
      indegrees.set(successorId, indegree);
      if (indegree === 0 && remaining.has(successorId)) ready.add(successorId);
    }
  }
  return remaining.size === 0 ? ordered : null;
}

/**
 * Merge only the consistent linear history rooted at the selected stream. A
 * candidate must align an agreeing contiguous interval with the admitted
 * chronology. Disconnected, forked, conflicting, and cyclic candidates are
 * rejected instead of being presented as one complete chronology.
 */
async function mergeConnectedConversation(
  streamLogStore: StreamLogStore,
  streamIds: readonly StreamTabId[],
): Promise<ArchiveMergeResult> {
  const entriesByStream = await Promise.all(
    streamIds.map(async (streamId) => {
      await streamLogStore.ensureLoaded(streamId);
      return streamLogStore.get(streamId)?.toJSON() ?? [];
    }),
  );
  const admittedIds: StreamTabId[] = [streamIds[0]];
  const admittedEntries: (readonly StreamLogEntry[])[] = [
    entriesByStream[0] ?? [],
  ];
  const admittedRows = new Map(
    admittedEntries[0]?.map((entry) => [entry.id, entry]) ?? [],
  );
  const diagnostics: CompletedRunArchiveDiagnostic[] = [];
  const canonicalOrder = orderMergedEntries(admittedEntries);
  if (canonicalOrder === null) {
    return {
      conversation: [],
      streamIds: admittedIds,
      diagnostics: [
        { kind: 'orderingCycle', streamId: streamIds[0] },
        ...streamIds.slice(1).map((streamId) => ({
          kind: 'disconnectedStream' as const,
          streamId,
        })),
      ],
    };
  }
  let ordered = canonicalOrder;

  const pending = entriesByStream.slice(1).flatMap((entries, index) => {
    const streamId = streamIds[index + 1];
    return streamId ? [{ streamId, entries }] : [];
  });
  while (pending.length > 0) {
    const overlappingIndexes = pending.flatMap(({ entries }, index) =>
      entries.some((entry) => admittedRows.has(entry.id)) ? [index] : [],
    );
    if (overlappingIndexes.length === 0) {
      diagnostics.push(
        ...pending.map(({ streamId }) => ({
          kind: 'disconnectedStream' as const,
          streamId,
        })),
      );
      break;
    }

    const rejected = new Map<number, CompletedRunArchiveDiagnostic>();
    for (const index of overlappingIndexes) {
      const candidate = pending[index]!;
      const conflict = candidate.entries.find(
        (entry) =>
          admittedRows.has(entry.id) &&
          !entriesAgree(admittedRows.get(entry.id)!, entry),
      );
      if (conflict) {
        rejected.set(index, {
          kind: 'conflictingRow',
          streamId: candidate.streamId,
          rowId: conflict.id,
        });
      } else if (!isSingleContinuation(ordered, candidate.entries)) {
        rejected.set(index, {
          kind: 'branchingHistory',
          streamId: candidate.streamId,
        });
      }
    }

    const compatibleIndexes = overlappingIndexes.filter(
      (index) => !rejected.has(index),
    );
    for (const [position, leftIndex] of compatibleIndexes.entries()) {
      const left = pending[leftIndex]!;
      for (const rightIndex of compatibleIndexes.slice(position + 1)) {
        const right = pending[rightIndex]!;
        const conflictingRow = left.entries.find((leftEntry) => {
          const rightEntry = right.entries.find(
            (entry) => entry.id === leftEntry.id,
          );
          return rightEntry && !entriesAgree(leftEntry, rightEntry);
        });
        if (conflictingRow) {
          rejected.set(leftIndex, {
            kind: 'conflictingRow',
            streamId: left.streamId,
            rowId: conflictingRow.id,
          });
          rejected.set(rightIndex, {
            kind: 'conflictingRow',
            streamId: right.streamId,
            rowId: conflictingRow.id,
          });
        } else if (!isSingleContinuation(left.entries, right.entries)) {
          rejected.set(leftIndex, {
            kind: 'branchingHistory',
            streamId: left.streamId,
          });
          rejected.set(rightIndex, {
            kind: 'branchingHistory',
            streamId: right.streamId,
          });
        }
      }
    }

    if (rejected.size > 0) {
      for (const index of [...rejected.keys()].toSorted((a, b) => b - a)) {
        pending.splice(index, 1);
      }
      diagnostics.push(
        ...[...rejected.entries()]
          .toSorted(([left], [right]) => left - right)
          .map(([, diagnostic]) => diagnostic),
      );
      continue;
    }

    const candidateIndex = compatibleIndexes[0];
    const candidate =
      candidateIndex === undefined
        ? undefined
        : pending.splice(candidateIndex, 1)[0];
    if (!candidate) continue;
    const { entries: candidateEntries, streamId } = candidate;
    const nextEntries = [...admittedEntries, candidateEntries];
    const nextOrder = orderMergedEntries(nextEntries);
    if (nextOrder === null) {
      diagnostics.push({ kind: 'orderingCycle', streamId });
      continue;
    }
    admittedIds.push(streamId);
    admittedEntries.push(candidateEntries);
    ordered = nextOrder;
    for (const entry of candidateEntries) admittedRows.set(entry.id, entry);
  }

  return {
    conversation: streamLogEntriesToConversation(ordered),
    streamIds: admittedIds,
    diagnostics,
  };
}

/**
 * Sidecar arm of the non-empty rule. Current executions normally need only
 * their registered primary. If it reconstructs empty, historical candidates
 * are tried in deterministic order before the legacy projection.
 */
async function readSidecarConversation(
  executionId: ExecutionId,
  resolved: PersistedStreamIdResolution,
  snapshotStore: StreamSnapshotStore,
  streamLogStore: StreamLogStore,
): Promise<CompletedRunConversationReadResult | null> {
  // Current executions register one canonical stream at birth; a disk-backed
  // release/reopen regression proves resumed turns append there. Only
  // pre-registration resolutions can represent historical split sidecars, so
  // keep the ordinary completed-read path constant-time.
  const mergeCandidateStreamIds = resolved.mergeCandidateStreamIds;
  if (mergeCandidateStreamIds !== undefined) {
    const orderedRoots = [
      ...(mergeCandidateStreamIds.includes(resolved.streamId)
        ? [resolved.streamId]
        : []),
      ...mergeCandidateStreamIds.filter(
        (streamId) => streamId !== resolved.streamId,
      ),
    ];
    const merged = await mergeConnectedConversation(
      streamLogStore,
      orderedRoots,
    );
    if (merged.conversation.length > 0) {
      return {
        conversation: merged.conversation,
        source: 'streamLog',
        streamId: orderedRoots[0],
        ...(merged.streamIds.length > 1 ? { streamIds: merged.streamIds } : {}),
        ...(merged.diagnostics.length > 0
          ? { diagnostics: merged.diagnostics }
          : {}),
      };
    }
    // An empty selected stream must fall back to the legacy execution
    // projection, never to a disconnected or conflicting candidate. Preserve
    // diagnostics so the caller does not mistake that exclusion for proof
    // that no other historical sidecar exists.
    return merged.diagnostics.length > 0
      ? {
          conversation: null,
          source: 'none',
          streamId: orderedRoots[0],
          diagnostics: merged.diagnostics,
        }
      : null;
  }

  const primaryConversation = await conversationFromStream(
    streamLogStore,
    resolved.streamId,
  );
  if (primaryConversation.length > 0) {
    return {
      conversation: primaryConversation,
      source: 'streamLog',
      streamId: resolved.streamId,
    };
  }

  const fallbackStreamIds =
    resolved.fallbackStreamIds ??
    (await findPersistedStreamFallbacksForExecution(
      executionId,
      resolved.streamId,
      { snapshotStore, streamLogStore },
    ));
  for (const streamId of fallbackStreamIds) {
    const conversation = await conversationFromStream(streamLogStore, streamId);
    if (conversation.length > 0) {
      return { conversation, source: 'streamLog', streamId };
    }
  }
  return null;
}

/**
 * Read the archived conversation for a completed run from the transcript
 * sidecar (`streamLogs/{stream}.json`), reconstructed into provider-agnostic
 * messages, with the legacy `executions/{id}/conversation.json` projection
 * as the fallback arm.
 *
 * The sidecar is tried first. If it has no conversation-shaped rows, the
 * reader falls back once to the historical projection. An empty source never
 * wins over a source with content.
 */
export async function readCompletedRunConversation(
  executionId: ExecutionId,
): Promise<CompletedRunConversationReadResult> {
  const snapshotStore = new StreamSnapshotStore();
  // A call-scoped read-only store, so this reader neither reloads a live store
  // nor mutates persistence.
  const streamLogStore = await StreamLogStore.openReadOnly();

  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
    streamLogStore,
  });

  const sidecar = resolved
    ? await readSidecarConversation(
        executionId,
        resolved,
        snapshotStore,
        streamLogStore,
      )
    : null;
  if (sidecar?.conversation) return sidecar;

  // Legacy `conversation.json`; `null` when missing or empty.
  const legacy = await getExecutionStore(executionId).readConversation();
  if (legacy) {
    return {
      conversation: legacy,
      source: 'legacyKV',
      ...(sidecar?.streamId ? { streamId: sidecar.streamId } : {}),
      ...(sidecar?.streamIds ? { streamIds: sidecar.streamIds } : {}),
      ...(sidecar?.diagnostics ? { diagnostics: sidecar.diagnostics } : {}),
    };
  }
  return sidecar ?? { conversation: null, source: 'none' };
}

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
    resolved?.streamId &&
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
  /** All overlap-connected sidecars used for a merged archive. */
  readonly streamIds?: readonly StreamTabId[];
  /** Exact-execution sidecars excluded because persisted evidence is insufficient. */
  readonly candidateStreamIds?: readonly StreamTabId[];
  /** Proven child associations retained as evidence but never read as archive rows. */
  readonly associatedStreamIds?: readonly StreamTabId[];
  /** Same row ID persisted with incompatible conversation payload or state. */
  readonly conflicts?: readonly CompletedRunConversationConflict[];
  /** Overlap constraints contradicted one another. */
  readonly hasOrderingCycle?: boolean;
  /** Overlap constraints did not establish one complete chronology. */
  readonly hasOrderingAmbiguity?: boolean;
}

/** Whether completed-run storage proves a conversation or transcript association exists. */
export function hasCompletedRunConversationEvidence(
  result: CompletedRunConversationReadResult,
): boolean {
  return (
    (result.conversation?.length ?? 0) > 0 ||
    result.streamId !== undefined ||
    (result.streamIds?.length ?? 0) > 0 ||
    (result.candidateStreamIds?.length ?? 0) > 0 ||
    (result.associatedStreamIds?.length ?? 0) > 0
  );
}

interface CompletedRunConversationConflict {
  readonly rowId: string;
  readonly streamIds: readonly StreamTabId[];
}

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

interface LoadedConversationStream {
  readonly streamId: StreamTabId;
  readonly entries: readonly StreamLogEntry[];
  readonly entriesById: ReadonlyMap<string, StreamLogEntry>;
}

interface MergedConversationResult {
  readonly conversation: unknown[];
  readonly streamIds: readonly StreamTabId[];
  readonly candidateStreamIds: readonly StreamTabId[];
  readonly conflicts: readonly CompletedRunConversationConflict[];
  readonly hasOrderingCycle: boolean;
  readonly hasOrderingAmbiguity: boolean;
}

function rowsAgree(left: StreamLogEntry, right: StreamLogEntry): boolean {
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

async function loadConversationStreams(
  streamLogStore: StreamLogStore,
  streamIds: readonly StreamTabId[],
): Promise<LoadedConversationStream[]> {
  return Promise.all(
    streamIds.map(async (streamId) => {
      await streamLogStore.ensureLoaded(streamId);
      const entries = streamLogStore.get(streamId)?.toJSON() ?? [];
      return {
        streamId,
        entries,
        entriesById: new Map(entries.map((entry) => [entry.id, entry])),
      };
    }),
  );
}

function sharedRows(
  left: LoadedConversationStream,
  right: LoadedConversationStream,
): {
  readonly overlaps: number;
  readonly conflictingIds: string[];
  readonly conversationConflictingIds: string[];
} {
  let overlaps = 0;
  const conflictingIds: string[] = [];
  const conversationConflictingIds: string[] = [];
  for (const [id, leftEntry] of left.entriesById) {
    const rightEntry = right.entriesById.get(id);
    if (!rightEntry) continue;
    if (rowsAgree(leftEntry, rightEntry)) {
      overlaps++;
      continue;
    }
    conflictingIds.push(id);
    if (
      conversationMessagesForEntry(leftEntry).length > 0 ||
      conversationMessagesForEntry(rightEntry).length > 0
    ) {
      conversationConflictingIds.push(id);
    }
  }
  return { overlaps, conflictingIds, conversationConflictingIds };
}

/**
 * Merge exact-execution sidecars connected by validated copied row IDs. When
 * no canonical stream is proven, every candidate must join the same component.
 * Stream-local adjacency supplies ordering; neither clocks nor per-stream
 * sequence numbers order disjoint rows.
 */
async function mergedCandidateConversation(
  streamLogStore: StreamLogStore,
  streamIds: readonly StreamTabId[],
  selectedStreamId?: StreamTabId,
): Promise<MergedConversationResult> {
  const streams = await loadConversationStreams(streamLogStore, streamIds);
  const neighbors = new Map<StreamTabId, Set<StreamTabId>>();
  const conflictingPairs: [StreamTabId, StreamTabId][] = [];
  const conflictStreamsById = new Map<string, Set<StreamTabId>>();
  for (const [index, left] of streams.entries()) {
    for (const right of streams.slice(index + 1)) {
      const { overlaps, conflictingIds, conversationConflictingIds } =
        sharedRows(left, right);
      if (conversationConflictingIds.length > 0) {
        conflictingPairs.push([left.streamId, right.streamId]);
      }
      for (const id of conflictingIds) {
        const conflictStreams = conflictStreamsById.get(id) ?? new Set();
        conflictStreams.add(left.streamId);
        conflictStreams.add(right.streamId);
        conflictStreamsById.set(id, conflictStreams);
      }
      if (overlaps === 0 || conversationConflictingIds.length > 0) continue;
      const leftNeighbors = neighbors.get(left.streamId) ?? new Set();
      leftNeighbors.add(right.streamId);
      neighbors.set(left.streamId, leftNeighbors);
      const rightNeighbors = neighbors.get(right.streamId) ?? new Set();
      rightNeighbors.add(left.streamId);
      neighbors.set(right.streamId, rightNeighbors);
    }
  }

  const selected = selectedStreamId
    ? streams.find(({ streamId }) => streamId === selectedStreamId)
    : undefined;
  const overlapAnchor = selected ?? streams[0];
  if (!overlapAnchor) {
    return {
      conversation: [],
      streamIds: [],
      candidateStreamIds: [],
      conflicts: [],
      hasOrderingCycle: false,
      hasOrderingAmbiguity: false,
    };
  }
  const connectedIds = new Set<StreamTabId>([overlapAnchor.streamId]);
  const queue = [overlapAnchor.streamId];
  for (const streamId of queue) {
    for (const neighbor of neighbors.get(streamId) ?? []) {
      if (connectedIds.has(neighbor)) continue;
      connectedIds.add(neighbor);
      queue.push(neighbor);
    }
  }
  const connected = streams.filter(({ streamId }) =>
    connectedIds.has(streamId),
  );
  const connectedConflict = conflictingPairs.some(
    ([left, right]) => connectedIds.has(left) && connectedIds.has(right),
  );
  let mergeStreams = connected;
  if (connectedConflict) mergeStreams = selected ? [selected] : [];
  const allNodes = new Map<string, StreamLogEntry>();
  const rowSuccessors = new Map<string, Set<string>>();
  // Persisted IDs identify conflict diagnostics, but only complete agreeing rows
  // represent the same ordering node. Keep incompatible copies stream-qualified.
  const rowVariantsById = new Map<
    string,
    { readonly graphId: string; readonly entry: StreamLogEntry }[]
  >();
  for (const { streamId, entries } of mergeStreams) {
    let previousGraphId: string | undefined;
    for (const entry of entries) {
      const variants = rowVariantsById.get(entry.id) ?? [];
      const matchingVariant = variants.find((variant) =>
        rowsAgree(variant.entry, entry),
      );
      const graphId =
        matchingVariant?.graphId ??
        (variants.length === 0
          ? entry.id
          : `${entry.id}\0${streamId}\0${variants.length}`);
      if (!matchingVariant) {
        variants.push({ graphId, entry });
        rowVariantsById.set(entry.id, variants);
        allNodes.set(graphId, entry);
      }
      if (previousGraphId && previousGraphId !== graphId) {
        const nextIds = rowSuccessors.get(previousGraphId) ?? new Set<string>();
        nextIds.add(graphId);
        rowSuccessors.set(previousGraphId, nextIds);
      }
      previousGraphId = graphId;
    }
  }

  // Diagnostic rows still prove copied-row overlap and carry payload conflicts,
  // but they do not produce archived messages. Contract paths through them so
  // they can preserve A < diagnostic < B without creating false branch choices
  // when two sidecars persisted different STATISTICS/PROGRESS rows between the
  // same conversation turns.
  const nodes = new Map(
    [...allNodes].filter(
      ([, entry]) =>
        entry.type === STREAM_LOG_ENTRY_TYPES.LOG &&
        conversationMessagesForEntry(entry).length > 0,
    ),
  );
  const successors = new Map<string, Set<string>>();
  const indegrees = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const sourceId of nodes.keys()) {
    const pending = [...(rowSuccessors.get(sourceId) ?? [])];
    const visitedDiagnostics = new Set<string>();
    for (const successorId of pending) {
      if (nodes.has(successorId)) {
        const nextIds = successors.get(sourceId) ?? new Set<string>();
        if (!nextIds.has(successorId)) {
          nextIds.add(successorId);
          successors.set(sourceId, nextIds);
          indegrees.set(successorId, (indegrees.get(successorId) ?? 0) + 1);
        }
        continue;
      }
      if (visitedDiagnostics.has(successorId)) continue;
      visitedDiagnostics.add(successorId);
      pending.push(...(rowSuccessors.get(successorId) ?? []));
    }
  }

  const remaining = new Set(nodes.keys());
  const ready = new Set(
    [...remaining].filter((id) => (indegrees.get(id) ?? 0) === 0),
  );
  const ordered: StreamLogEntry[] = [];
  let hasOrderingCycle = false;
  let hasOrderingAmbiguity = false;
  while (remaining.size > 0) {
    if (ready.size === 0) {
      hasOrderingCycle = true;
      break;
    }
    if (ready.size > 1) hasOrderingAmbiguity = true;
    const nextId = ready.values().next().value as string;
    const next = nodes.get(nextId);
    if (!next) break;
    ordered.push(next);
    ready.delete(nextId);
    remaining.delete(nextId);
    for (const successorId of successors.get(nextId) ?? []) {
      const indegree = (indegrees.get(successorId) ?? 0) - 1;
      indegrees.set(successorId, indegree);
      if (indegree === 0 && remaining.has(successorId)) ready.add(successorId);
    }
  }

  const mergeTrusted =
    !connectedConflict &&
    !hasOrderingCycle &&
    !hasOrderingAmbiguity &&
    (selected !== undefined || connected.length === streams.length);
  let usedStreams: LoadedConversationStream[] = [];
  let conversation: unknown[] = [];
  if (mergeTrusted) {
    usedStreams = mergeStreams;
    conversation = streamLogEntriesToConversation(ordered);
  } else if (selected) {
    usedStreams = [selected];
    conversation = streamLogEntriesToConversation(selected.entries);
  }
  const usedIds = new Set(usedStreams.map(({ streamId }) => streamId));
  const streamOrder = new Map(
    streams.map(({ streamId }, index) => [streamId, index]),
  );
  return {
    conversation,
    streamIds: usedStreams.map(({ streamId }) => streamId),
    candidateStreamIds: streams
      .map(({ streamId }) => streamId)
      .filter((streamId) => !usedIds.has(streamId)),
    conflicts: [...conflictStreamsById]
      .map(([rowId, ids]) => ({
        rowId,
        streamIds: [...ids].toSorted(
          (left, right) =>
            (streamOrder.get(left) ?? 0) - (streamOrder.get(right) ?? 0),
        ),
      }))
      .toSorted((left, right) => left.rowId.localeCompare(right.rowId)),
    hasOrderingCycle,
    hasOrderingAmbiguity,
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
  // pre-registration resolutions scan historical candidates, so keep the
  // ordinary completed-read path constant-time.
  const associationDiagnostics =
    resolved.associatedStreamIds && resolved.associatedStreamIds.length > 0
      ? { associatedStreamIds: resolved.associatedStreamIds }
      : {};
  const exactCandidates = resolved.exactExecutionCandidateStreamIds;
  if (exactCandidates !== undefined) {
    const orderedCandidates = resolved.streamId
      ? [
          resolved.streamId,
          ...exactCandidates.filter(
            (streamId) => streamId !== resolved.streamId,
          ),
        ]
      : exactCandidates;
    const merged = await mergedCandidateConversation(
      streamLogStore,
      orderedCandidates,
      resolved.streamId,
    );
    const diagnostics = {
      ...associationDiagnostics,
      ...(resolved.streamId ? { streamId: resolved.streamId } : {}),
      ...(merged.streamIds.length > 1 ? { streamIds: merged.streamIds } : {}),
      ...(merged.candidateStreamIds.length > 0
        ? { candidateStreamIds: merged.candidateStreamIds }
        : {}),
      ...(merged.conflicts.length > 0 ? { conflicts: merged.conflicts } : {}),
      ...(merged.hasOrderingCycle ? { hasOrderingCycle: true } : {}),
      ...(merged.hasOrderingAmbiguity ? { hasOrderingAmbiguity: true } : {}),
    };
    if (merged.conversation.length > 0) {
      return {
        conversation: merged.conversation,
        source: 'streamLog',
        ...diagnostics,
      };
    }
    // Exact metadata established the selected stream and candidate set. An
    // empty selected conversation falls back to the legacy projection, never
    // to a child, disconnected candidate, or suffix-only sidecar. Preserve
    // the association diagnostics so every persisted root remains findable.
    return { conversation: null, source: 'none', ...diagnostics };
  }

  if (!resolved.streamId) {
    return resolved.associatedStreamIds?.length
      ? { conversation: null, source: 'none', ...associationDiagnostics }
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
      ...associationDiagnostics,
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
      return {
        conversation,
        source: 'streamLog',
        streamId,
        ...associationDiagnostics,
      };
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

  // Legacy `conversation.json`; absent or empty leaves the sidecar diagnostics
  // as the only answer.
  const legacyConversation =
    await getExecutionStore(executionId).readConversation();
  if (!legacyConversation) {
    return sidecar ?? { conversation: null, source: 'none' };
  }
  return {
    conversation: legacyConversation,
    source: 'legacyKV',
    ...(sidecar?.candidateStreamIds
      ? { candidateStreamIds: sidecar.candidateStreamIds }
      : {}),
    ...(sidecar?.associatedStreamIds
      ? { associatedStreamIds: sidecar.associatedStreamIds }
      : {}),
    ...(sidecar?.conflicts ? { conflicts: sidecar.conflicts } : {}),
    ...(sidecar?.hasOrderingCycle ? { hasOrderingCycle: true } : {}),
    ...(sidecar?.hasOrderingAmbiguity ? { hasOrderingAmbiguity: true } : {}),
  };
}

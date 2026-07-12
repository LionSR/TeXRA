/**
 * Completed-run archive reads (#7246 Decision 1): once a run finishes, its
 * durable display/export data is owned by the transcript sidecars
 * (`streamLogs/{stream}.json` + `streamData/{stream}/*`), keyed through the
 * execution→stream mapping. The legacy `executions/{id}/conversation.json` /
 * `todos.json` KV projections are READ-ONLY fallbacks for runs recorded
 * before the sidecars existed (or written by builds that still project them)
 * — each fact keeps exactly ONE legacy read arm, here, tracked for D3
 * retirement in the #6981 ledger.
 */
import pMap from 'p-map';

import { getExecutionStore, type TodoEntry } from '@agent/storage';
import { mediaAttachmentKindToContentBlock } from '@agent/export/attachmentMarkerVocabulary';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';
import { isFileNotFoundError } from '@common/errors';
import { KVStore } from '@common/storage/KVStore';
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
import { StorageFS } from '@utils/files';
import { assertNever } from '@utils/core';

import { resolvePersistedStreamIdForExecution } from './executionStreamResolver';
import { STREAM_DATA_KEYS, streamDataDir } from './streamDataPaths';
import { StreamLogStore, STREAM_LOGS_DIR } from './StreamLogStore';
import { StreamSnapshotStore } from './StreamSnapshotStore';

type CompletedRunTodosSource = 'streamData' | 'legacyKV' | 'none';

export interface CompletedRunTodosReadResult {
  readonly todos: TodoEntry[];
  readonly source: CompletedRunTodosSource;
  readonly streamId?: StreamTabId;
}

export interface CompletedRunReaderOptions {
  readonly snapshotStore?: StreamSnapshotStore;
}

function todoItemToEntry(todo: TodoItem): TodoEntry {
  return {
    content: todo.content,
    status: todo.status,
  };
}

function workPlanPath(streamId: StreamTabId): string {
  return `${streamDataDir(streamId)}/${STREAM_DATA_KEYS.WORK_PLAN}.json`;
}

/** Sidecar `workPlan.json` mtime (ms since epoch), or `undefined` if absent. */
async function sidecarModifiedAt(
  streamId: StreamTabId,
): Promise<number | undefined> {
  try {
    return (await StorageFS.stat(workPlanPath(streamId))).mtime;
  } catch (err) {
    if (isFileNotFoundError(err)) return undefined;
    throw err;
  }
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
 * stream sidecar (`streamData/{stream}/workPlan.json`) but falling back to
 * `executions/{id}/todos.json` for runs recorded before sidecars existed —
 * or when the legacy write is demonstrably fresher than the sidecar (a final
 * `todo_write` can land before the snapshot store's asynchronous sidecar
 * write has flushed).
 *
 * Freshness detail: millisecond-resolution mtimes (the VS Code filesystem
 * adapter's granularity) can tie when both writes land in the same tick;
 * ties are broken toward the legacy write, since a genuinely later legacy
 * write is the more likely cause of a tie than a genuinely later sidecar
 * write racing to complete in the same millisecond.
 */
export async function readCompletedRunTodos(
  executionId: ExecutionId,
  options: CompletedRunReaderOptions = {},
): Promise<CompletedRunTodosReadResult> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
  });

  if (!resolved) return readLegacyTodos(executionId);

  const sidecarMtime = await sidecarModifiedAt(resolved.streamId);
  if (sidecarMtime === undefined) {
    return readLegacyTodos(executionId);
  }

  const legacyMtime = await getExecutionStore(executionId).todosModifiedAt();
  if (legacyMtime !== undefined && legacyMtime >= sidecarMtime) {
    return readLegacyTodos(executionId);
  }

  const snapshot = await snapshotStore.read(resolved.streamId);
  return {
    todos: snapshot.todos.map(todoItemToEntry),
    source: 'streamData',
    streamId: resolved.streamId,
  };
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
}

export interface CompletedRunConversationReaderOptions extends CompletedRunReaderOptions {
  /**
   * An already-open store. When omitted a call-scoped read-only instance is
   * opened so this reader neither reloads a live store nor mutates persistence.
   */
  readonly streamLogStore?: StreamLogStore;
}

/** `streamLogs/{stream}.json` mtime (ms since epoch), or `undefined` if absent. */
function streamLogModifiedAt(
  streamId: StreamTabId,
): Promise<number | undefined> {
  return new KVStore(STREAM_LOGS_DIR).modifiedAt(streamId);
}

/**
 * Deliberate non-goal (#7508): image blocks inside a tool result are not
 * reconstructed here. `ToolUseLog.output` only ever carries display text —
 * a local `ToolResult.output` is a plain string, and any image content a
 * tool_result block sends to the provider is built at message-construction
 * time from `ToolResult.files` (base64 attachment bytes), which never
 * reaches the transcript row. Unlike the web-fetch page-content case,
 * there's no existing size-capped/marker-only slot for this in the export
 * pipeline (`ExportNode`'s `tool-result` kind is `{text}` only), and
 * reconstructing one would mean threading attachment bytes through
 * `tool.end` just to summarize them — out of scope here.
 */
function toolResultText(tool: ToolUseLog): string | undefined {
  if (tool.error !== undefined) return tool.error;
  if (typeof tool.output === 'string') return tool.output;
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
  if (attachments.length === 0) {
    return [{ role: 'user', content: entry.text }];
  }
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: entry.text },
        ...attachments.map(mediaAttachmentKindToContentBlock),
      ],
    },
  ];
}

function modelResponseEntryToMessages(entry: StreamLogEntry): unknown[] {
  if (!entry.text?.trim()) return [];
  return [{ role: 'assistant', content: [{ type: 'text', text: entry.text }] }];
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
    case MESSAGE_TYPES.ERROR:
    case MESSAGE_TYPES.INTERNAL:
    case MESSAGE_TYPES.CONTEXT_MANAGEMENT:
    case MESSAGE_TYPES.CONTEXT_STATE:
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

/** Legacy `conversation.json` read; `null` when missing or empty. */
async function readLegacyConversationMessages(
  executionId: ExecutionId,
): Promise<unknown[] | null> {
  return getExecutionStore(executionId).readConversation();
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

/** Bounded fan-out for the sibling meta scan (mirrors the resolver's). */
const CONVERSATION_CANDIDATE_SCAN_CONCURRENCY = 8;

/**
 * Sibling sidecar streams for the same execution, tried only when the
 * resolver's pick reconstructs empty (cold path). #7433's resolver ranking
 * (log-backed > workPlan-only > bare, scan order within a rank) stays the
 * primary criteria — this layers the has-content preference on top without
 * teaching the generic resolver (also used by the todos reader and the
 * trace assembler) what "conversation content" means. Only log-backed
 * siblings can yield content, so the rest are skipped.
 */
async function siblingConversationStreams(
  executionId: ExecutionId,
  primary: StreamTabId,
  snapshotStore: StreamSnapshotStore,
  streamLogStore: StreamLogStore,
): Promise<StreamTabId[]> {
  const persisted = await snapshotStore.listPersistedStreams();
  const metaMatched = (
    await pMap(
      persisted,
      async (streamId) => ({
        streamId,
        executionId: await snapshotStore.readPersistedExecutionId(streamId),
      }),
      { concurrency: CONVERSATION_CANDIDATE_SCAN_CONCURRENCY },
    )
  )
    .filter((candidate) => candidate.executionId === executionId)
    .map((candidate) => candidate.streamId);

  const suffix = `#${executionId}`;
  const suffixMatched = [...persisted, ...streamLogStore.keys()].filter((id) =>
    id.endsWith(suffix),
  );

  const seen = new Set<StreamTabId>([primary]);
  const siblings: StreamTabId[] = [];
  for (const streamId of [...metaMatched, ...suffixMatched]) {
    if (seen.has(streamId) || !streamLogStore.has(streamId)) continue;
    seen.add(streamId);
    siblings.push(streamId);
  }
  return siblings;
}

/**
 * Sidecar arm of the non-empty rule: the resolver's pick first, then —
 * only if it reconstructs empty — every other log-backed sibling stream
 * sharing this executionId, in the same deterministic enumeration order the
 * resolver scans. Returns `null` when no candidate yields content.
 */
async function readSidecarConversation(
  executionId: ExecutionId,
  primary: StreamTabId,
  snapshotStore: StreamSnapshotStore,
  streamLogStore: StreamLogStore,
): Promise<CompletedRunConversationReadResult | null> {
  const primaryConversation = await conversationFromStream(
    streamLogStore,
    primary,
  );
  if (primaryConversation.length > 0) {
    return {
      conversation: primaryConversation,
      source: 'streamLog',
      streamId: primary,
    };
  }
  for (const streamId of await siblingConversationStreams(
    executionId,
    primary,
    snapshotStore,
    streamLogStore,
  )) {
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
 * Arbitration protocol: the mtime comparison (ties toward legacy, same as
 * {@link readCompletedRunTodos}) decides the ORDER the two sources are
 * tried in — but **an empty result never wins**. A source that reads or
 * reconstructs empty (a present-but-empty legacy file, a resolver pick
 * whose log holds no conversation-shaped rows) falls through to the next
 * source, symmetrically in both directions, until one yields content or
 * all are empty.
 */
export async function readCompletedRunConversation(
  executionId: ExecutionId,
  options: CompletedRunConversationReaderOptions = {},
): Promise<CompletedRunConversationReadResult> {
  const snapshotStore = options.snapshotStore ?? new StreamSnapshotStore();
  let streamLogStore = options.streamLogStore;
  if (!streamLogStore) {
    streamLogStore = await StreamLogStore.openReadOnly();
  }
  const loadedStreamLogStore = streamLogStore;

  const resolved = await resolvePersistedStreamIdForExecution(executionId, {
    snapshotStore,
    streamLogStore,
  });

  const tryLegacy =
    async (): Promise<CompletedRunConversationReadResult | null> => {
      const conversation = await readLegacyConversationMessages(executionId);
      return conversation ? { conversation, source: 'legacyKV' } : null;
    };
  const trySidecar =
    async (): Promise<CompletedRunConversationReadResult | null> =>
      resolved
        ? readSidecarConversation(
            executionId,
            resolved.streamId,
            snapshotStore,
            loadedStreamLogStore,
          )
        : null;

  // Freshness decides order only. The resolver pick's streamLogs mtime
  // stands in for "the sidecar's" — an absent log file orders legacy first
  // (without even statting the legacy file), and the sidecar arm still gets
  // its turn if legacy is empty.
  const sidecarMtime = resolved
    ? await streamLogModifiedAt(resolved.streamId)
    : undefined;
  let legacyFirst = true;
  if (sidecarMtime !== undefined) {
    const legacyMtime =
      await getExecutionStore(executionId).conversationModifiedAt();
    legacyFirst = legacyMtime !== undefined && legacyMtime >= sidecarMtime;
  }

  const arms = legacyFirst ? [tryLegacy, trySidecar] : [trySidecar, tryLegacy];
  for (const arm of arms) {
    const result = await arm();
    if (result) return result;
  }
  return { conversation: null, source: 'none' };
}

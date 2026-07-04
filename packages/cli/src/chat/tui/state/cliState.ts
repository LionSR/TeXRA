// Signal-backed state for the CLI TUI. Mirrors the webview's `progressState`
// shape — same primitives (`@lit-labs/signals`), same shape (one record per
// stream + an `activeStreamId`) so future feature parity is a port, not a
// rewrite. Phase 4 extends with per-stream subagent/process/todos/plan/
// process-output fields plus the per-stream bypass-state badges the
// StatusBar consumes.

import { signal, Signal } from '@lit-labs/signals';

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliModelSelectionSource } from '@cli/runtime/modelAccess';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import {
  STREAM_STATUS,
  type ActiveChildInfo,
  type AgentCategory,
  type ConversationProgress,
  type NormalizedToolUse,
  type Plan,
  type StreamLifecycleStatus,
  type StreamSubstate,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';

interface ConversationEntryBase {
  /** Same id as the upstream `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  /** Concatenated text for `MODEL_RESPONSE` entries. Empty for tool rows. */
  readonly text: string;
  /** True while rendered assistant text is hiding an incomplete protocol block. */
  readonly pendingEmbeddedSubagentFollowup?: boolean;
  /** True once the stream transitions to `WAITING`/`COMPLETED`. */
  readonly finalized: boolean;
  /** Entry was synthesized by the CLI and is not present in StreamLogStore. */
  readonly synthetic?: boolean;
  /** Why the CLI synthesized this entry. */
  readonly syntheticKind?: 'final' | 'local' | 'process';
  /** StreamLog head at the moment a synthetic entry was appended. */
  readonly syntheticAfterSeq?: number;
}

/**
 * Discriminated on `role` so `toolUse`/`process` are required exactly for
 * the rows that need them, instead of independently-optional fields every
 * consumer has to null-check regardless of role.
 */
export type ConversationEntry =
  | (ConversationEntryBase & { readonly role: 'assistant' | 'error' | 'user' })
  | (ConversationEntryBase & {
      readonly role: 'tool';
      readonly toolUse: NormalizedToolUse;
    })
  | (ConversationEntryBase & {
      readonly role: 'process';
      readonly process: CompletedProcessTranscript;
    });

export interface CompletedProcessTranscript {
  readonly executionId: string;
  readonly title: string;
  readonly status?: string;
  readonly elapsed?: string | null;
  readonly isError: boolean;
  readonly tailLines: readonly string[];
}

export interface SessionMeta {
  readonly agent: string;
  readonly model: string;
  readonly modelSource: CliModelSelectionSource;
  readonly cwd: string;
  readonly apiMode: CliApiMode;
  readonly approvalPolicy: CliApprovalPolicy;
  readonly canDelegate: boolean;
  readonly teamName?: string;
  readonly version: string;
}

export interface ProcessOutputTail {
  readonly stdout: string;
  readonly stderr: string;
}

export interface BypassState {
  readonly bash: boolean;
  readonly toolEdit: boolean;
  readonly superYolo: boolean;
}

export interface StreamSlice {
  readonly streamId: StreamTabId;
  /** Model identity captured from setTaskState for this specific stream. */
  readonly model?: string | undefined;
  /** Agent category for this stream (`toolUse` / `workflow` / …), captured
   *  from `setTaskState` or `setActiveStream`. Lets the exit hint list only
   *  resumable tool-use subagents (workflows don't resume). */
  readonly category: AgentCategory | undefined;
  readonly status: StreamLifecycleStatus | undefined;
  readonly substate?: StreamSubstate;
  /** Epoch ms when this stream last entered `RUNNING`; cleared on any other
   *  status. Drives the StatusBar's live elapsed-time segment so a long
   *  token-less "thinking" turn still shows liveness. */
  readonly runStartedAt: number | undefined;
  readonly description: string | undefined;
  /** Latest model usage snapshot. The StatusBar treats this as current context
   *  occupancy, so it must not be accumulated across turns. */
  readonly usage: TokenUsageStats | undefined;
  /** Accumulated usage for resume/exit summaries across all turns in this
   *  stream. Kept separate from `usage` so the context-window indicator remains
   *  a latest-snapshot display. */
  readonly cumulativeUsage: TokenUsageStats | undefined;
  /** True while the latest hidden provider-side reasoning/thinking stream is
   *  the current live activity. The CLI never renders the content directly;
   *  this only drives a lightweight liveness indicator. */
  readonly thinkingActive: boolean;
  readonly conversation: ConversationProgress | undefined;
  readonly entries: readonly ConversationEntry[];
  readonly queuedFollowUps: number;
  readonly queuedFollowUpMessages: readonly string[];
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly activeProcesses: readonly ActiveChildInfo[];
  /** Child streams seen for this parent. This keeps completed/waiting
   * subagent pages addressable after they leave the active list. */
  readonly childStreams: readonly ActiveChildInfo[];
  readonly todos: readonly TodoItem[];
  readonly plan: Plan | null;
  /** Tailed stdout/stderr per execution id; latest only — capped at
   *  `PROCESS_TAIL_CHARS_MAX` in subscribeRuntimeHost. */
  readonly processOutput: ReadonlyMap<string, ProcessOutputTail>;
  /** YOLO / auto-approval state is stream-scoped upstream (see
   *  `permissionSlice.ts` in the extension), so concurrent parent/child
   *  sessions can show distinct badges. */
  readonly bypass: BypassState;
}

/**
 * Shared gate for the "model is thinking" indicators (the StatusBar segment
 * and the conversation pane's liveness row) so the two can never disagree:
 * the hidden reasoning phase is only worth surfacing while the stream is
 * actually running — any final or waiting status supersedes it.
 */
export function thinkingIndicatorVisible(
  slice:
    | { readonly status: string | undefined; readonly thinkingActive: boolean }
    | undefined,
): boolean {
  return (
    slice?.thinkingActive === true && slice.status === STREAM_STATUS.RUNNING
  );
}

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  model: '',
  modelSource: 'builtin',
  cwd: '',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  canDelegate: false,
  version: '',
};

const SESSION_META = signal<SessionMeta>(EMPTY_SESSION_META);

const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_STREAM_ID = signal<StreamTabId | undefined>(undefined);

const STREAMS = signal<ReadonlyMap<StreamTabId, StreamSlice>>(new Map());
const ROOT_RUN_START_AVAILABLE = signal<boolean>(true);

/** child -> parent map populated from child stream ownership events. The focus
 *  cycle (Ctrl-A / Ctrl-B) walks this when stepping back to the parent, and
 *  transcript rendering uses it to keep child streams scoped to their own
 *  history. */
const PARENT_STREAM = signal<ReadonlyMap<StreamTabId, StreamTabId>>(new Map());

/** Active inline slash form, or `undefined` when the chat input owns the
 *  screen. The form's `onDone` clears this slot. Kept opaque (the form
 *  carries its own state) so the registry stays declarative. */
export interface ActiveSlashForm {
  /** The slash command that mounted the form (for the header strip). */
  readonly commandName: string;
  /** Status-bar verb for Escape while the form owns input. Defaults to close. */
  readonly escapeAction?: string;
  /** Render the form body. Receives the close callback. */
  readonly render: (
    onDone: () => void,
    availableRows: number,
  ) => React.ReactNode;
}
const ACTIVE_FORM = signal<ActiveSlashForm | undefined>(undefined);

/** True while the slash-command palette is mounted in the InputBar. App-level
 *  Tab handlers gate on this so palette-Tab (accept selection) doesn't double
 *  with stream-focus Tab. */
const SLASH_PALETTE_OPEN = signal<boolean>(false);
const REVERSE_SEARCH_OPEN = signal<boolean>(false);

/** The stream whose full-output transcript the viewer is showing, or
 *  `undefined` when the viewer is closed. ctrl+t opens it on the active
 *  stream; the Subagents picker opens it on a chosen child so each subagent's
 *  transcript is independently browsable without disturbing the main
 *  scrollback. The viewer shows that one stream's tool output untruncated and
 *  scrollable; the finalized scrollback and live region only ever show a
 *  head+tail slice. */
const TRANSCRIPT_VIEWER_STREAM_ID = signal<StreamTabId | undefined>(undefined);

const PENDING_EXIT_HINT = signal<boolean>(false);
const PENDING_EXIT_RESUME_ID = signal<string | undefined>(undefined);

// Bumped whenever the in-process ChatGPT-subscription preference changes (via
// `/subscription`) so the status bar re-reads it immediately instead of waiting
// for its periodic poll. External changes (extension/desktop/config edits) are
// still picked up by that poll.
const CODEX_PREFERENCE_VERSION = signal<number>(0);

const RESET_HOOKS = new Set<() => void>();

export const cliState = {
  sessionMeta: SESSION_META as Signal.State<SessionMeta>,
  activeStreamId: ACTIVE_STREAM_ID as Signal.State<StreamTabId | undefined>,
  rootStreamId: ROOT_STREAM_ID as Signal.State<StreamTabId | undefined>,
  streams: STREAMS as Signal.State<ReadonlyMap<StreamTabId, StreamSlice>>,
  rootRunStartAvailable: ROOT_RUN_START_AVAILABLE as Signal.State<boolean>,
  parentStream: PARENT_STREAM as Signal.State<
    ReadonlyMap<StreamTabId, StreamTabId>
  >,
  activeForm: ACTIVE_FORM as Signal.State<ActiveSlashForm | undefined>,
  slashPaletteOpen: SLASH_PALETTE_OPEN as Signal.State<boolean>,
  reverseSearchOpen: REVERSE_SEARCH_OPEN as Signal.State<boolean>,
  transcriptViewerStreamId: TRANSCRIPT_VIEWER_STREAM_ID as Signal.State<
    StreamTabId | undefined
  >,
  pendingExitHint: PENDING_EXIT_HINT as Signal.State<boolean>,
  pendingExitResumeId: PENDING_EXIT_RESUME_ID as Signal.State<
    string | undefined
  >,
  codexPreferenceVersion: CODEX_PREFERENCE_VERSION as Signal.State<number>,
};

/** Signal the status bar to re-read the ChatGPT-subscription preference now. */
export function bumpCodexPreferenceVersion(): void {
  cliState.codexPreferenceVersion.set(
    cliState.codexPreferenceVersion.get() + 1,
  );
}

export function setCliSessionModelOverride(model: string): void {
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    model,
    modelSource: 'override',
  });
}

export const NO_BYPASS: BypassState = {
  bash: false,
  toolEdit: false,
  superYolo: false,
};

function emptySlice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    model: undefined,
    category: undefined,
    status: undefined,
    substate: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeSubagents: [],
    activeProcesses: [],
    childStreams: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
  };
}

export function patchStream(
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): void {
  const current = cliState.streams.get();
  const slice = current.get(streamId) ?? emptySlice(streamId);
  const next = update(slice);
  if (next === slice) return;
  const out = new Map(current);
  out.set(streamId, next);
  cliState.streams.set(out);
}

function streamSliceWithStatus(
  slice: StreamSlice,
  status: StreamLifecycleStatus,
  substate: StreamSubstate | undefined,
  nowMs: number,
): StreamSlice {
  const runStartedAt =
    status === STREAM_STATUS.RUNNING
      ? (slice.runStartedAt ?? nowMs)
      : undefined;
  if (
    slice.status === status &&
    slice.substate === substate &&
    slice.runStartedAt === runStartedAt
  ) {
    return slice;
  }
  return { ...slice, status, substate, runStartedAt };
}

function updateChildStatusReferences(
  children: readonly ActiveChildInfo[],
  childStreamId: StreamTabId,
  status: StreamLifecycleStatus,
): readonly ActiveChildInfo[] {
  let out: ActiveChildInfo[] | undefined;
  children.forEach((child, index) => {
    if (child.childStreamId !== childStreamId || child.status === status) {
      return;
    }
    out ??= [...children];
    out[index] = { ...child, status };
  });
  return out ?? children;
}

function withMirroredChildStreamStatus(
  slice: StreamSlice,
  childStreamId: StreamTabId,
  status: StreamLifecycleStatus,
): StreamSlice {
  return mapChildStreamReferenceLists(slice, (children) =>
    updateChildStatusReferences(children, childStreamId, status),
  );
}

/**
 * Apply a stream-status event once to the CLI state mirror.
 *
 * Runtime status still originates in StreamStatusService, but TUI renderers
 * should read only StreamSlice data. Updating retained parent child rows here
 * keeps side panels, tab labels, focus routing, and follow-up targeting on the
 * same state snapshot instead of re-querying the runtime service at render time.
 */
export function setStreamStatusInCliState({
  nowMs = Date.now(),
  status,
  substate,
  streamId,
}: {
  readonly nowMs?: number;
  readonly status: StreamLifecycleStatus;
  readonly substate?: StreamSubstate;
  readonly streamId: StreamTabId;
}): void {
  const current = cliState.streams.get();
  let out: Map<StreamTabId, StreamSlice> | undefined;

  const existingSlice = current.get(streamId);
  const targetSlice = streamSliceWithStatus(
    existingSlice ?? emptySlice(streamId),
    status,
    substate,
    nowMs,
  );
  if (targetSlice !== existingSlice) {
    out = new Map(current);
    out.set(streamId, targetSlice);
  }

  const readable = out ?? current;
  for (const [id, slice] of readable) {
    const next = withMirroredChildStreamStatus(slice, streamId, status);
    if (next === slice) continue;
    out ??= new Map(current);
    out.set(id, next);
  }

  if (out) cliState.streams.set(out);
}

interface ParentStreamEdgeUpdate {
  readonly childStreamId?: StreamTabId;
  readonly parentStreamId: StreamTabId | null | undefined;
}

function parentStreamMapUpdate(
  current: ReadonlyMap<StreamTabId, StreamTabId>,
  updates: readonly ParentStreamEdgeUpdate[],
): Map<StreamTabId, StreamTabId> | undefined {
  let out: Map<StreamTabId, StreamTabId> | undefined;
  for (const { childStreamId, parentStreamId } of updates) {
    if (!childStreamId) continue;
    const readable = out ?? current;
    if (parentStreamId == null) {
      if (!readable.has(childStreamId)) continue;
      out ??= new Map(current);
      out.delete(childStreamId);
      continue;
    }
    if (readable.get(childStreamId) === parentStreamId) continue;
    out ??= new Map(current);
    out.set(childStreamId, parentStreamId);
  }
  return out;
}

function commitParentStreamEdges(
  updates: readonly ParentStreamEdgeUpdate[],
): void {
  const next = parentStreamMapUpdate(cliState.parentStream.get(), updates);
  if (next) cliState.parentStream.set(next);
}

export function setParentStream(
  childStreamId: StreamTabId,
  parentStreamId: StreamTabId | null | undefined,
): void {
  // A null parent means the runtime promoted this child to a top-level stream.
  commitParentStreamEdges([{ childStreamId, parentStreamId }]);
}

export function registerChildStreams(
  parentStreamId: StreamTabId,
  children: readonly ActiveChildInfo[],
): void {
  commitParentStreamEdges(
    children.map((child) => ({
      childStreamId: child.childStreamId,
      parentStreamId,
    })),
  );
}

export function removeStream(streamId: StreamTabId): void {
  const current = cliState.streams.get();
  const out = new Map(current);
  let changed = out.delete(streamId);
  for (const [id, slice] of out) {
    const next = scrubChildStreamReferences(slice, streamId);
    if (next === slice) continue;
    out.set(id, next);
    changed = true;
  }
  if (changed) cliState.streams.set(out);
  if (cliState.activeStreamId.get() === streamId) {
    cliState.activeStreamId.set(undefined);
  }
  // Drop any parent-map edges that touched this stream so the focus cycle
  // never lands on a stale id.
  const parents = cliState.parentStream.get();
  let nextParents: Map<StreamTabId, StreamTabId> | undefined;
  for (const [child, parent] of parents) {
    if (child !== streamId && parent !== streamId) continue;
    if (!nextParents) nextParents = new Map(parents);
    nextParents.delete(child);
  }
  if (nextParents) cliState.parentStream.set(nextParents);
}

function scrubChildStreamReferences(
  slice: StreamSlice,
  streamId: StreamTabId,
): StreamSlice {
  return mapChildStreamReferenceLists(slice, (children) =>
    removeChildStreamReference(children, streamId),
  );
}

function mapChildStreamReferenceLists(
  slice: StreamSlice,
  mapChildren: (
    children: readonly ActiveChildInfo[],
  ) => readonly ActiveChildInfo[],
): StreamSlice {
  const activeSubagents = mapChildren(slice.activeSubagents);
  const activeProcesses = mapChildren(slice.activeProcesses);
  const childStreams = mapChildren(slice.childStreams);
  if (
    activeSubagents === slice.activeSubagents &&
    activeProcesses === slice.activeProcesses &&
    childStreams === slice.childStreams
  ) {
    return slice;
  }
  return { ...slice, activeSubagents, activeProcesses, childStreams };
}

function removeChildStreamReference(
  children: readonly ActiveChildInfo[],
  streamId: StreamTabId,
): readonly ActiveChildInfo[] {
  const next = children.filter((child) => child.childStreamId !== streamId);
  return next.length === children.length ? children : next;
}

function defaultSessionMeta(): SessionMeta {
  // Preserve the resolved CLI version across resets; everything else clears.
  return { ...EMPTY_SESSION_META, version: SESSION_META.get().version };
}

export function resetCliState(sessionMeta = defaultSessionMeta()): void {
  cliState.sessionMeta.set(sessionMeta);
  cliState.activeStreamId.set(undefined);
  cliState.rootStreamId.set(undefined);
  cliState.streams.set(new Map());
  cliState.rootRunStartAvailable.set(true);
  cliState.parentStream.set(new Map());
  cliState.activeForm.set(undefined);
  cliState.slashPaletteOpen.set(false);
  cliState.reverseSearchOpen.set(false);
  cliState.transcriptViewerStreamId.set(undefined);
  cliState.pendingExitHint.set(false);
  cliState.pendingExitResumeId.set(undefined);
  for (const resetHook of RESET_HOOKS) resetHook();
}

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

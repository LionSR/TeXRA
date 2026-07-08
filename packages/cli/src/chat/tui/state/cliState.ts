/**
 * CLI TUI shared signal store. All view-level state (streams, session,
 * focus, overlays, exit hints) lives here as signals; formerly one file per
 * slice under `cliState/`.
 */
import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import {
  type ActiveChildInfo,
  type AgentCategory,
  type ConversationProgress,
  type NormalizedToolUse,
  type Plan,
  type RoundStage,
  STREAM_STATUS,
  type StreamLifecycleStatus,
  type StreamSubstate,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';
import { signal, type Signal } from '@lit-labs/signals';
import type { ChildControlMode } from './childControls';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

// Data model for the CLI TUI's signal-backed state. Mirrors the webview's
// `progressState` shape — same primitives (`@lit-labs/signals`), same shape
// (one record per stream + an `activeStreamId`) so future feature parity is a
// port, not a rewrite. Phase 4 extends with per-stream subagent/process/todos/
// plan/process-output fields plus the per-stream bypass-state badges the
// StatusBar consumes.

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
  readonly syntheticKind?: 'local' | 'process';
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
  readonly modelSource: RunModelDecisionReason;
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
  readonly roundStage?: RoundStage | undefined;
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
    roundStage: undefined,
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

// ---------------------------------------------------------------------------
// streamsSlice
// ---------------------------------------------------------------------------

// Per-stream state map plus the status/child-reference update machinery that
// operates on it. This is the largest slice: every `StreamSlice` field lives
// behind this one map, patched immutably so `useSignal` subscribers only
// re-render on an actual change.

const STREAMS = signal<ReadonlyMap<StreamTabId, StreamSlice>>(new Map());

/** Per-stream state map, keyed by `StreamTabId`. */
export const streams = STREAMS;

export function patchStream(
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): void {
  const current = STREAMS.get();
  const slice = current.get(streamId) ?? emptySlice(streamId);
  const next = update(slice);
  if (next === slice) return;
  const out = new Map(current);
  out.set(streamId, next);
  STREAMS.set(out);
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
    if (
      child.kind !== 'subagent' ||
      child.childStreamId !== childStreamId ||
      child.status === status
    ) {
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
  const current = STREAMS.get();
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

  if (out) STREAMS.set(out);
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
  const next = children.filter(
    (child) => child.kind !== 'subagent' || child.childStreamId !== streamId,
  );
  return next.length === children.length ? children : next;
}

function scrubChildStreamReferences(
  slice: StreamSlice,
  streamId: StreamTabId,
): StreamSlice {
  return mapChildStreamReferenceLists(slice, (children) =>
    removeChildStreamReference(children, streamId),
  );
}

// ---------------------------------------------------------------------------
// sessionSlice
// ---------------------------------------------------------------------------

// Session-identity slice: the agent/model/cwd/approval snapshot for the
// current CLI session. One signal, no cross-stream concerns.

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  model: '',
  modelSource: 'builtin-default',
  cwd: '',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  canDelegate: false,
  version: '',
};

const SESSION_META = signal<SessionMeta>(EMPTY_SESSION_META);

/** Agent/model/cwd/approval snapshot for the current CLI session. */
export const sessionMeta = SESSION_META;

export function patchSessionMeta(patch: Partial<SessionMeta>): void {
  SESSION_META.set({ ...SESSION_META.get(), ...patch });
}

export function setCliSessionModelOverride(model: string): void {
  patchSessionMeta({ model, modelSource: 'explicit-override' });
}

/** Preserve the resolved CLI version across resets; everything else clears. */
function defaultSessionMeta(): SessionMeta {
  return { ...EMPTY_SESSION_META, version: SESSION_META.get().version };
}

// ---------------------------------------------------------------------------
// focusSlice
// ---------------------------------------------------------------------------

// Which stream is focused / rooted, and whether starting a new root run is
// currently available. No update logic beyond plain get/set lives here —
// stream-lifecycle side effects that touch these signals alongside others
// (e.g. `removeStream`) live in `./removeStream`.

const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_RUN_START_AVAILABLE = signal<boolean>(true);

/** The stream currently focused in the transcript / status bar. */
export const activeStreamId = ACTIVE_STREAM_ID;
/** The top-level stream the current session rooted at. */
export const rootStreamId = ROOT_STREAM_ID;
/** Whether starting a new root run is currently available. */
export const rootRunStartAvailable = ROOT_RUN_START_AVAILABLE;

// ---------------------------------------------------------------------------
// parentStreamSlice
// ---------------------------------------------------------------------------

// child -> parent map populated from child stream ownership events. The focus
// cycle (Ctrl-A / Ctrl-B) walks this when stepping back to the parent, and
// transcript rendering uses it to keep child streams scoped to their own
// history.

const PARENT_STREAM = signal<ReadonlyMap<StreamTabId, StreamTabId>>(new Map());

/** child -> parent stream-id map. */
export const parentStream = PARENT_STREAM;

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
  const next = parentStreamMapUpdate(PARENT_STREAM.get(), updates);
  if (next) PARENT_STREAM.set(next);
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
      childStreamId:
        child.kind === 'subagent' ? child.childStreamId : undefined,
      parentStreamId,
    })),
  );
}

// ---------------------------------------------------------------------------
// foregroundOverlaySlice
// ---------------------------------------------------------------------------

// Signals for the App-level foreground surfaces — the inline slash form, the
// slash-command palette, reverse search, the transcript viewer, and the
// child-control (subagents/tasks) picker. These are view-level toggles, so
// per the CLAUDE.md TUI rule they live here as signal state rather than as
// local `useState` in the components that render them.

/** Active inline slash form, or `undefined` when the chat input owns the
 *  screen. The form's `onDone` clears this slot. Kept opaque (the form
 *  carries its own state) so the registry stays declarative. */
interface ActiveSlashForm {
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
const ACTIVE_FORM: Signal.State<ActiveSlashForm | undefined> = signal<
  ActiveSlashForm | undefined
>(undefined);
/** Active inline slash form, or `undefined` when the chat input owns the screen. */
export const activeForm = ACTIVE_FORM;

/** True while the slash-command palette is mounted in the InputBar. App-level
 *  Tab handlers gate on this so palette-Tab (accept selection) doesn't double
 *  with stream-focus Tab. */
const SLASH_PALETTE_OPEN = signal<boolean>(false);
export const slashPaletteOpen = SLASH_PALETTE_OPEN;
const REVERSE_SEARCH_OPEN = signal<boolean>(false);
export const reverseSearchOpen = REVERSE_SEARCH_OPEN;

/** The stream whose full-output transcript the viewer is showing, or
 *  `undefined` when the viewer is closed. ctrl+t opens it on the active
 *  stream; the Subagents picker opens it on a chosen child so each subagent's
 *  transcript is independently browsable without disturbing the main
 *  scrollback. The viewer shows that one stream's tool output untruncated and
 *  scrollable; the finalized scrollback and live region only ever show a
 *  head+tail slice. */
const TRANSCRIPT_VIEWER_STREAM_ID = signal<StreamTabId | undefined>(undefined);
export const transcriptViewerStreamId = TRANSCRIPT_VIEWER_STREAM_ID;

/** Which child-control picker (subagents/tasks) App is showing in the
 *  foreground, or `undefined` when neither is open. */
const CHILD_CONTROL_MODE: Signal.State<ChildControlMode | undefined> = signal<
  ChildControlMode | undefined
>(undefined);
export const childControlMode = CHILD_CONTROL_MODE;
/** Status-bar verb for Escape while the child-control picker owns input;
 *  the picker reports this as it navigates between its list and detail view. */
const CHILD_CONTROL_ESCAPE_ACTION = signal<string>('close');
export const childControlEscapeAction = CHILD_CONTROL_ESCAPE_ACTION;

// ---------------------------------------------------------------------------
// exitHintSlice
// ---------------------------------------------------------------------------

// Ctrl-C-to-exit resume hint: whether the next exit should surface a resume
// id, and which run it points at.

const PENDING_EXIT_HINT = signal<boolean>(false);
const PENDING_EXIT_RESUME_ID = signal<string | undefined>(undefined);

/** Whether the next exit should surface a resume hint. */
export const pendingExitHint = PENDING_EXIT_HINT;
/** Which run the pending exit hint's resume id points at. */
export const pendingExitResumeId = PENDING_EXIT_RESUME_ID;

// ---------------------------------------------------------------------------
// codexPreferenceSlice
// ---------------------------------------------------------------------------

// Bumped whenever the in-process ChatGPT-subscription preference changes (via
// `/subscription`) so the status bar re-reads it immediately instead of waiting
// for its periodic poll. External changes (extension/desktop/config edits) are
// still picked up by that poll.

const CODEX_PREFERENCE_VERSION = signal<number>(0);

export const codexPreferenceVersion = CODEX_PREFERENCE_VERSION;

/** Signal the status bar to re-read the ChatGPT-subscription preference now. */
export function bumpCodexPreferenceVersion(): void {
  CODEX_PREFERENCE_VERSION.set(CODEX_PREFERENCE_VERSION.get() + 1);
}

// ---------------------------------------------------------------------------
// removeStream
// ---------------------------------------------------------------------------

// Cross-slice cleanup when a stream goes away: drops it from the streams map,
// scrubs any child-reference lists that pointed at it, clears focus if it was
// active, and drops parent-map edges that touched it.

export function removeStream(streamId: StreamTabId): void {
  const current = streams.get();
  const out = new Map(current);
  let changed = out.delete(streamId);
  for (const [id, slice] of out) {
    const next = scrubChildStreamReferences(slice, streamId);
    if (next === slice) continue;
    out.set(id, next);
    changed = true;
  }
  if (changed) streams.set(out);
  if (activeStreamId.get() === streamId) {
    activeStreamId.set(undefined);
  }
  // Drop any parent-map edges that touched this stream so the focus cycle
  // never lands on a stale id.
  const parents = parentStream.get();
  let nextParents: Map<StreamTabId, StreamTabId> | undefined;
  for (const [child, parent] of parents) {
    if (child !== streamId && parent !== streamId) continue;
    if (!nextParents) nextParents = new Map(parents);
    nextParents.delete(child);
  }
  if (nextParents) parentStream.set(nextParents);
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

// Full-state reset between CLI sessions (e.g. `/clear`), plus the hook
// registry other state modules use to reset their own signals in step.

const RESET_HOOKS = new Set<() => void>();

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

export function resetCliState(
  nextSessionMeta: SessionMeta = defaultSessionMeta(),
): void {
  sessionMeta.set(nextSessionMeta);
  activeStreamId.set(undefined);
  rootStreamId.set(undefined);
  streams.set(new Map());
  rootRunStartAvailable.set(true);
  parentStream.set(new Map());
  activeForm.set(undefined);
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  transcriptViewerStreamId.set(undefined);
  childControlMode.set(undefined);
  childControlEscapeAction.set('close');
  pendingExitHint.set(false);
  pendingExitResumeId.set(undefined);
  for (const resetHook of RESET_HOOKS) resetHook();
}

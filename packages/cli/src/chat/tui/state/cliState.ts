/**
 * CLI TUI shared signal store. All view-level state (streams, session,
 * focus, overlays, exit hints) lives here as signals.
 */
import { computed, signal, type Signal } from '@lit-labs/signals';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type {
  ActiveSkillSummary,
  AgentDelegationScope,
  ApiAccessMode,
  CompileFailure,
  ConversationProgress,
  MessageType,
  NormalizedToolUse,
  OutputFileInfo,
  Plan,
  RoundIndexed,
  RunIdentity,
  StreamLogEntry,
  StreamPhase,
  StreamStage,
  StreamSubstate,
  StreamTabId,
  TaskGroup,
  TodoItem,
  TokenUsageStats,
  UserFollowUpSupport,
  WorkflowCallProgress,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { latestWorkflowAttemptId } from '@shared/copy/workflowCall';
import type {
  CompactionActivityBlock,
  CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import { isActivePhase } from '@shared/streams/streamStatus';
import {
  applyChildStreamRemoval,
  isChildStreamRemoved,
  resetChildStreamEntries,
} from './childExecutions';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

// Data model for the CLI TUI's signal-backed state. Mirrors the webview's
// `progressState` shape — same primitives (`@lit-labs/signals`), same shape
// (one record per stream + an `activeStreamId`) so future feature parity is a
// port, not a rewrite.

interface ConversationEntryBase {
  /** Same id as the upstream `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  /** Rendered log text. Empty for tool rows. */
  readonly text: string;
  /** Original shared log vocabulary. Role alone intentionally groups several
   * display kinds and is not precise enough for semantic selection. */
  readonly messageType?: MessageType;
  /** True while rendered assistant text is hiding an incomplete protocol block. */
  readonly pendingEmbeddedSubagentFollowup?: boolean;
  /** True once the stream transitions to `WAITING`/`COMPLETED`. */
  readonly finalized: boolean;
}

type ConversationEntryOrigin =
  | {
      /** Source-backed row persisted by StreamLogStore. */
      readonly synthetic?: false;
      /** Durable StreamLog position, including legacy rows without settlement order. */
      readonly sourceSeqNo?: number;
      /** Source-owned order in which this immutable row became printable. */
      readonly settlementSeqNo?: number;
      readonly syntheticKind?: never;
      readonly syntheticAfterSeq?: never;
      readonly syntheticAfterSettlementSeqNo?: never;
    }
  | {
      /** CLI-owned row that is not present in StreamLogStore. */
      readonly synthetic: true;
      readonly sourceSeqNo?: never;
      readonly settlementSeqNo?: never;
      /** Why the CLI synthesized this entry. */
      readonly syntheticKind: 'local';
      /** StreamLog head at the moment this row was appended. */
      readonly syntheticAfterSeq: number;
      /** Durable settlement cursor when this row became printable. */
      readonly syntheticAfterSettlementSeqNo: number;
    };

export interface LoadedImage {
  readonly path: string;
  readonly sizeBytes: number;
}

/**
 * Discriminated on `role` so `toolUse` is required exactly for the rows that
 * need it, instead of an independently-optional field every consumer has to
 * null-check regardless of role.
 */
export type ConversationEntry = ConversationEntryOrigin &
  (
    | (ConversationEntryBase & {
        readonly role: 'assistant' | 'error' | 'user';
      })
    | (ConversationEntryBase & {
        readonly role: 'activity';
        readonly activity: CompactionActivityBlock;
      })
    | (ConversationEntryBase & {
        readonly role: 'workflowTask';
        /** Parsed workflow-call state retained for semantic settlement and styling. */
        readonly task: WorkflowCallProgress;
      })
    | (ConversationEntryBase & {
        readonly role: 'phase';
        /** Phase title displayed in the group-header divider row. */
        readonly phaseLabel: string;
        /** 0-based phase order within the run, when the emitter provides it. */
        readonly phaseIndex?: number;
        /** Total phase count for the run, when the emitter provides it. */
        readonly phaseTotal?: number;
        /** Physical workflow attempt that emitted this phase. */
        readonly attemptId?: string;
      })
    | (ConversationEntryBase & {
        readonly role: 'tool';
        readonly toolUse: NormalizedToolUse;
      })
    | (ConversationEntryBase & {
        readonly role: 'media';
        readonly images: readonly LoadedImage[];
      })
  );

/** Resolve the current workflow attempt from session state, with a legacy transcript fallback. */
export function currentWorkflowAttemptId(
  declaredAttemptId: string | undefined,
  entries: readonly ConversationEntry[],
  boundaryDeclared: boolean,
): string | null | undefined {
  if (boundaryDeclared) return declaredAttemptId ?? null;
  return (
    declaredAttemptId ??
    latestWorkflowAttemptId(
      entries.map((entry) => {
        if (entry.role === 'workflowTask') return entry.task.attemptId;
        if (entry.role === 'phase') return entry.attemptId;
        return undefined;
      }),
    )
  );
}

/**
 * One transcript-projection candidate: a rendered row plus the ordering key
 * that places it in the final merged transcript order (log rows by seqNo,
 * compaction rows by start position, CLI-synthetic rows by their insertion
 * anchor). `rank` preserves the relative order of equal keys across the three
 * sources. `rendered` is replaced in place when the source row changes or the
 * settled-prefix promotion reaches it; the item object itself is stable.
 */
export interface TranscriptFoldItem {
  rendered: ConversationEntry;
  readonly sortSeq: number;
  readonly tieBreak: number;
  /** Equal-key source order: 0 = compaction row, 1 = log row, 2 = synthetic. */
  readonly rank: 0 | 1 | 2;
  /** Compaction rows: the block `rendered` was built from; reference equality
   *  means the row is current. */
  block?: CompactionActivityBlock;
}

/**
 * Incremental task-group projection state: the upsert engine's mutable
 * working set plus the immutable `snapshot` the slice holds. `applied`
 * remembers the last log-entry object applied per group row — `StreamLog`
 * replaces the entry object on every update (including the in-place
 * GROUP_START → GROUP_END upsert at stage end), so a reference change is
 * exactly a content change and only new/changed rows are fed to
 * `upsertTaskGroupFromStreamLog`, never a full re-projection. That same
 * reference dedupe makes the memo survive fold rebuilds unchanged: a
 * `getRange(0)` replay skips every already-applied entry.
 */
interface TaskGroupProjectionState {
  readonly working: TaskGroup[];
  readonly index: Map<string, number>;
  readonly applied: Map<string, StreamLogEntry>;
  snapshot: readonly TaskGroup[];
}

/** Incremental compaction-activity projection state, cursored on the source
 *  log (`appliedHead`), so it too survives fold rebuilds. */
interface CompactionProjectionState {
  readonly projection: CompactionActivityProjection;
  appliedHead: number;
  terminal: boolean;
}

/**
 * Mutable per-stream transcript-projection working state. Carried on the
 * stream's slice (never rendered) so its lifetime is exactly the stream's:
 * it dies with stream removal and CLI-state reset, and is cleared when the
 * stream's transcript is released. `subscribeStreamLog`'s fold over
 * store-emitted `StreamLogDelta`s maintains it in O(delta); a fresh or gapped
 * consumer rebuilds it from `getRange(0)` through the same application path.
 */
export interface TranscriptFoldState {
  /** False until a rebuild has run; cleared again when the stream's transcript is released. */
  hydrated: boolean;
  /** The `StreamLog` instance + emission seq `items` reflects. A mismatch
   *  with the store's current log means fold continuity is broken: rebuild. */
  logInstanceId: number;
  emissionSeq: number;
  /** Final transcript order: log, compaction, and synthetic rows merged. */
  readonly items: TranscriptFoldItem[];
  readonly indexById: Map<string, number>;
  /** First index the contiguous settled-prefix promotion has not covered. */
  finalizedFrontier: number;
  /** Index of the last user row with text, or -1 (latest-line fallback). */
  latestUserPos: number;
  /** Index of the last finalized model-response row with text, or -1. */
  latestResponsePos: number;
  /** Projection-mode bits `items` was built under; a flip forces a rebuild. */
  fullLogChild: boolean;
  workflowOperationalOnly: boolean;
  projectLifecycleToTaskGroups: boolean;
  /** Highest-seq ACTIVE_SKILLS entry, with its parse cached by reference. */
  activeSkillsEntry?: StreamLogEntry;
  activeSkillsParsedFor?: StreamLogEntry;
  activeSkills: readonly ActiveSkillSummary[];
  /** Highest-seq live-activity entry (drives the thinking indicator). */
  liveActivityEntry?: StreamLogEntry;
  /** Latest durable workflow-attempt marker and its source order. */
  workflowAttemptId?: string;
  workflowAttemptBoundaryDeclared: boolean;
  workflowAttemptSeqNo: number;
  /** Synthetic rows reconciled into `items`, in slice order, by identity. */
  synthetics: readonly ConversationEntry[];
  /** Incremental task-group / compaction memos. Unlike the fold fields above
   *  they are NOT cleared by a fold rebuild (each is self-consistent against
   *  a full replay); they are dropped only when the stream's transcript
   *  residency is released, and die with the slice like everything here. */
  taskGroupProjection?: TaskGroupProjectionState;
  compactionProjection?: CompactionProjectionState;
  /** Whether the last emitted `entries` was the full transcript or compact;
   *  undefined until the first emission. */
  lastOutputFull?: boolean;
  /** The exact `entries` array last emitted. A slice whose entries no longer
   *  match was patched out of band (synthetic rows), so the next application
   *  must rebuild its output instead of reusing `slice.entries`. */
  lastEntriesOutput?: readonly ConversationEntry[];
}

export interface SessionMeta {
  readonly agent: string;
  readonly category: AgentCategory;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly apiMode: ApiAccessMode;
  readonly approvalPolicy: TexraApprovalPolicy;
  readonly canDelegate: boolean;
  readonly transcriptMode: 'persistent' | 'ephemeral';
  readonly teamName?: string;
  readonly cliMultiAgentPresetId?: string;
  readonly delegationAgentScope?: AgentDelegationScope;
  readonly version: string;
}

export interface BypassState {
  readonly bash: boolean;
  readonly toolEdit: boolean;
  readonly superYolo: boolean;
}

/** File roles attached to one agent run. Kept as one optional value so the
 *  transcript slice does not duplicate derived counts alongside the paths. */
interface StreamFileMetadata {
  readonly input: readonly string[];
  readonly context: readonly string[];
  readonly media: readonly string[];
  readonly output: readonly string[];
}

export interface StreamSlice {
  readonly streamId: StreamTabId;
  /** What owns this stream, verbatim from `run.start` (or the durable store
   *  on cold read). Never re-derived from names, ids, or transcript roles. */
  readonly identity?: RunIdentity | undefined;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport | undefined;
  /** Canonical agent name captured from this stream's `run.config`. */
  readonly agent?: string | undefined;
  /** Model identity captured from setTaskState for this specific stream. */
  readonly model?: string | undefined;
  /** Agent category for this stream (`toolUse` / `workflow` / …), captured
   *  from `setTaskState` or `setActiveStream`. Lets the exit hint list only
   *  resumable tool-use subagents (workflows don't resume). */
  readonly category: AgentCategory | undefined;
  /** Normalized run files received with `run.config`. Absent until that fact
   *  arrives; each category may then be empty. */
  readonly files?: StreamFileMetadata | undefined;
  /** Canonical workflow artifacts, projected from the shared
   *  `StreamSnapshotStore` accumulator — never accumulated here. */
  readonly outputFilesByRound: RoundIndexed<OutputFileInfo>;
  readonly missingOutputsByRound: RoundIndexed<string>;
  readonly compileFailuresByRound: RoundIndexed<CompileFailure>;
  /** Run/round/phase lifecycle projected from the canonical StreamLog. */
  readonly taskGroups: readonly TaskGroup[];
  /** Latest physical workflow attempt declared by the durable stream. */
  readonly workflowAttemptId?: string | undefined;
  /** Whether the stream declared an attempt boundary, valid or malformed. */
  readonly workflowAttemptBoundaryDeclared: boolean;
  readonly status: StreamPhase | undefined;
  readonly substate?: StreamSubstate;
  /** Epoch ms when this stream last entered `RUNNING`; cleared on any other
   *  status. Drives the StatusBar's live elapsed-time segment so a long
   *  token-less "thinking" turn still shows liveness. */
  readonly runStartedAt: number | undefined;
  /** Authoritative one-line description of what this stream is doing, owned by
   *  the runtime (`updateStreamDescription`): the generated session
   *  description for a tool-use run, or the delegated task for a child stream.
   *  The same value the progress view shows; never derived from the
   *  transcript. */
  readonly description: string | undefined;
  /** CLI-only live status: the newest meaningful transcript line for this
   *  stream, recomputed on every log sync. Fills the stream-list summary slot
   *  until the runtime supplies a `description`. */
  readonly latestLine: string | undefined;
  /** Latest model usage snapshot. The StatusBar treats this as current context
   *  occupancy, so it must not be accumulated across turns. */
  readonly usage: TokenUsageStats | undefined;
  /** Whole-stream usage for resume/exit summaries: the store's per-run
   *  accumulator (`getRunUsage`) summed, never a second running sum here.
   *  Kept separate from `usage` so the context-window indicator remains a
   *  latest-snapshot display. */
  readonly cumulativeUsage: TokenUsageStats | undefined;
  /** True while the latest hidden provider-side reasoning/thinking stream is
   *  the current live activity. The CLI never renders the content directly;
   *  this only drives a lightweight liveness indicator. */
  readonly thinkingActive: boolean;
  /** True while the runtime is summarizing prior conversation context. */
  readonly compactingActive: boolean;
  readonly conversation: ConversationProgress | undefined;
  /** Round/turn progress (tool-use runs) or workflow-script phase progress
   *  (workflow runs) — a run advances through phases or rounds, never both,
   *  so one discriminated slot fills the same row/segment either renderer
   *  reads, instead of two independently-optional fields every consumer had
   *  to fall back between. */
  readonly stage?: StreamStage | undefined;
  readonly entries: readonly ConversationEntry[];
  /** Transcript-projection working state (see {@link TranscriptFoldState}).
   *  A mutable box owned by `subscribeStreamLog`; renderers ignore it. */
  readonly transcriptFold?: TranscriptFoldState;
  readonly queuedFollowUpMessages: readonly string[];
  readonly activeSkills: readonly ActiveSkillSummary[];
  readonly todos: readonly TodoItem[];
  readonly plan: Plan | null;
  /** YOLO / auto-approval state is stream-scoped upstream (see
   *  `permissionSlice.ts` in the extension), so concurrent parent/child
   *  sessions can show distinct badges. */
  readonly bypass: BypassState;
}

export const NO_BYPASS: BypassState = {
  bash: false,
  toolEdit: false,
  superYolo: false,
};

/** The zero value of a stream slice: every field at its pre-run default.
 *  Tests build fixtures from this so a new `StreamSlice` field cannot drift
 *  away from what the store actually seeds. */
export function emptySlice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    agent: undefined,
    model: undefined,
    category: undefined,
    status: undefined,
    substate: undefined,
    runStartedAt: undefined,
    description: undefined,
    latestLine: undefined,
    outputFilesByRound: {},
    missingOutputsByRound: {},
    compileFailuresByRound: {},
    taskGroups: [],
    workflowAttemptId: undefined,
    workflowAttemptBoundaryDeclared: false,
    thinkingActive: false,
    compactingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    stage: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    activeSkills: [],
    todos: [],
    plan: null,
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

/** Per-stream state map, keyed by `StreamTabId`. */
export const streams = signal<ReadonlyMap<StreamTabId, StreamSlice>>(new Map());
const RETIRED_STREAMS = new Set<StreamTabId>();

/** Whether reset retired this stream identity from the current state lifetime. */
export function isCliStreamRetired(streamId: StreamTabId): boolean {
  return RETIRED_STREAMS.has(streamId);
}

/** A stream slice minus the lifecycle triple. `status`, its `substate`, and
 *  the `runStartedAt` derived from them belong to
 *  {@link setStreamStatusInCliState}, which is the only writer that enforces
 *  the removed/retired liveness rule. */
type PatchableStreamSlice = Omit<
  StreamSlice,
  'status' | 'substate' | 'runStartedAt'
>;

/** What a `patchStream` updater may return: the patchable fields, with the
 *  lifecycle triple closed off so re-writing `status` from a patch is a
 *  compile error rather than a second, unguarded status owner. */
type StreamSlicePatch = PatchableStreamSlice & {
  readonly status?: never;
  readonly substate?: never;
  readonly runStartedAt?: never;
};

/**
 * Patch one stream's view state. The updater receives the same slice twice:
 * once typed for patching (no lifecycle fields to spread back) and once whole,
 * for the patches that derive from the current status.
 */
export function patchStream(
  streamId: StreamTabId,
  update: (
    slice: PatchableStreamSlice,
    lifecycle: Readonly<
      Pick<StreamSlice, 'status' | 'substate' | 'runStartedAt'>
    >,
  ) => StreamSlicePatch,
): void {
  RETIRED_STREAMS.delete(streamId);
  const current = streams.get();
  const slice = current.get(streamId) ?? emptySlice(streamId);
  const next = update(slice, slice);
  if (next === slice) return;
  const out = new Map(current);
  out.set(streamId, {
    ...next,
    status: slice.status,
    substate: slice.substate,
    runStartedAt: slice.runStartedAt,
  });
  streams.set(out);
}

function streamSliceWithStatus(
  slice: StreamSlice,
  status: StreamPhase,
  substate: StreamSubstate | undefined,
  nowMs: number,
): StreamSlice {
  const runStartedAt = isActivePhase(status)
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

/**
 * Apply a stream-status event once to the CLI state mirror.
 *
 * Runtime status still originates in the default session's status machine
 * (`defaultSession().status`), but TUI renderers should read only
 * StreamSlice data. The child `StreamSlice` is the single
 * status owner for retained/active child rows too: `childExecutions.ts`'s
 * selectors read status from here directly, so no copy into another
 * collection is needed. A status for a stream tombstoned by `removeStream`
 * is ignored — removal is final for that stream identity.
 */
export function setStreamStatusInCliState({
  nowMs = Date.now(),
  status,
  substate,
  streamId,
}: {
  readonly nowMs?: number;
  readonly status: StreamPhase;
  readonly substate?: StreamSubstate;
  readonly streamId: StreamTabId;
}): boolean {
  if (isChildStreamRemoved(streamId) || RETIRED_STREAMS.has(streamId)) {
    return false;
  }
  const current = streams.get();
  const existingSlice = current.get(streamId);
  const targetSlice = streamSliceWithStatus(
    existingSlice ?? emptySlice(streamId),
    status,
    substate,
    nowMs,
  );
  if (targetSlice === existingSlice) return true;
  const out = new Map(current);
  out.set(streamId, targetSlice);
  streams.set(out);
  return true;
}

// ---------------------------------------------------------------------------
// sessionSlice
// ---------------------------------------------------------------------------

// Session-identity slice: the agent/model/cwd/approval display snapshot for the
// current CLI session. One signal, no cross-stream concerns.

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  category: AgentCategory.ToolUse,
  model: '',
  modelSource: 'builtin-default',
  cwd: '',
  apiMode: 'personal',
  approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
  canDelegate: false,
  transcriptMode: 'persistent',
  version: '',
};

/** Reactive display snapshot for the current CLI session. */
export const sessionMeta = signal<SessionMeta>(EMPTY_SESSION_META);

export function patchSessionMeta(patch: Partial<SessionMeta>): void {
  sessionMeta.set({ ...sessionMeta.get(), ...patch });
}

export function setCliSessionModelOverride(model: string): void {
  patchSessionMeta({ model, modelSource: 'explicit-override' });
}

/** Preserve process-session properties across conversation resets. */
function defaultSessionMeta(): SessionMeta {
  const current = sessionMeta.get();
  return {
    ...EMPTY_SESSION_META,
    transcriptMode: current.transcriptMode,
    version: current.version,
  };
}

// ---------------------------------------------------------------------------
// focusSlice
// ---------------------------------------------------------------------------

// Which stream is focused / rooted, and whether starting a new root run is
// currently available. Focus moves only through `focusStream`;
// stream-lifecycle side effects that touch these signals alongside others
// (e.g. `removeStream`) live in the `removeStream` section below.

/** The stream currently focused in the transcript / status bar. */
export const activeStreamId = signal<StreamTabId | undefined>(undefined);

/**
 * Move transcript/status focus onto a stream. Sole focus writer: a stream
 * identity tombstoned by `removeStream`, or retired by `resetCliState`, is
 * never focused, so a fact that arrives after the row is gone cannot pull the
 * view onto a stream that no longer exists. `onlyIfUnset` is for the facts
 * that adopt focus only while nothing holds it (the first log sync, the first
 * local transcript row).
 */
export function focusStream(
  streamId: StreamTabId,
  options: { readonly onlyIfUnset?: boolean } = {},
): void {
  if (isChildStreamRemoved(streamId) || RETIRED_STREAMS.has(streamId)) return;
  if (options.onlyIfUnset && activeStreamId.get() !== undefined) return;
  activeStreamId.set(streamId);
}

/** The top-level stream the current session rooted at. */
export const rootStreamId = signal<StreamTabId | undefined>(undefined);
/** Whether starting a new root run is currently available. */
export const rootRunStartAvailable = signal<boolean>(true);
/** Whether the root session holds an unfinished run claim (run promise
 *  pending). Published only by `TuiSession`, so renders read the session
 *  run-state reactively instead of calling impure session closures that
 *  memoized renders would cache stale (#8273). */
export const rootRunPending = signal<boolean>(false);
/** Run-control mirror of `TuiSession.streamId` — cleared while a new run is
 *  pending, unlike `rootStreamId`, which stays put as the transcript anchor
 *  across pending windows. Published only by `TuiSession`. */
export const rootRunStreamId = signal<StreamTabId | undefined>(undefined);

// ---------------------------------------------------------------------------
// foregroundOverlaySlice
// ---------------------------------------------------------------------------

// Signals for the App-level foreground surfaces: the inline slash form,
// slash-command palette, and reverse search. These view-level toggles live
// here as signal state rather than local component state.

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
export const activeForm: Signal.State<ActiveSlashForm | undefined> = signal<
  ActiveSlashForm | undefined
>(undefined);

interface InfoPaneContent {
  readonly title: string;
  readonly lines: readonly string[];
}

const INFO_PANE_QUEUE = signal<readonly InfoPaneContent[]>([]);
export const infoPane: Signal.Computed<InfoPaneContent | undefined> = computed(
  () => INFO_PANE_QUEUE.get().at(0),
);

/** Open regenerable reference text in the foreground pane. */
export function openInfoPane(title: string, text: string): void {
  INFO_PANE_QUEUE.set([
    ...INFO_PANE_QUEUE.get(),
    { title, lines: text.replaceAll('\r\n', '\n').split('\n') },
  ]);
}

/** Close the active reference pane and reveal any concurrently queued result. */
export function closeInfoPane(): void {
  INFO_PANE_QUEUE.set(INFO_PANE_QUEUE.get().slice(1));
}

/** Passive reader target. Holding the captured stream id rather than a text
 * snapshot keeps each reader live even if transcript focus moves elsewhere. */
export interface WorkPlanReaderRequest {
  readonly revision: number;
  readonly streamId: StreamTabId;
}

export type ForegroundReaderTarget =
  | { readonly kind: 'transcript'; readonly streamId: StreamTabId }
  | {
      readonly kind: 'workPlan';
      readonly streamId: StreamTabId;
      readonly loading?: false;
    }
  | {
      readonly kind: 'workPlan';
      readonly streamId: StreamTabId;
      readonly loading: true;
      readonly requestRevision: number;
    };

const FOREGROUND_READER = signal<ForegroundReaderTarget | undefined>(undefined);
let WORK_PLAN_REQUEST_REVISION = 0;
export const foregroundReader: Signal.Computed<
  ForegroundReaderTarget | undefined
> = computed(() => FOREGROUND_READER.get());

export function openTranscriptReader(streamId: StreamTabId): void {
  FOREGROUND_READER.set({ kind: 'transcript', streamId });
}

/** Capture one `/plan` invocation as the sole owner of async reader output. */
export function beginWorkPlanReaderRequest(
  streamId: StreamTabId,
): WorkPlanReaderRequest {
  const request = { streamId, revision: ++WORK_PLAN_REQUEST_REVISION };
  FOREGROUND_READER.set({
    kind: 'workPlan',
    streamId,
    loading: true,
    requestRevision: request.revision,
  });
  return request;
}

export function workPlanReaderRequestIsCurrent(
  request: WorkPlanReaderRequest,
): boolean {
  const target = FOREGROUND_READER.get();
  return (
    target?.kind === 'workPlan' &&
    target.loading === true &&
    target.streamId === request.streamId &&
    target.requestRevision === request.revision
  );
}

/** Resolve the loading reader without allowing an older request to replace it. */
export function finishWorkPlanReaderRequest(
  request: WorkPlanReaderRequest,
): boolean {
  if (!workPlanReaderRequestIsCurrent(request)) return false;
  FOREGROUND_READER.set({ kind: 'workPlan', streamId: request.streamId });
  return true;
}

export function cancelPendingWorkPlanReaderRequest(): void {
  const target = FOREGROUND_READER.get();
  if (target?.kind === 'workPlan' && target.loading === true) {
    FOREGROUND_READER.set(undefined);
  }
}

/** Close only the loading reader owned by this invocation. */
export function cancelWorkPlanReaderRequest(
  request: WorkPlanReaderRequest,
): boolean {
  if (!workPlanReaderRequestIsCurrent(request)) return false;
  FOREGROUND_READER.set(undefined);
  return true;
}

export function closeForegroundReader(): void {
  FOREGROUND_READER.set(undefined);
}

/** True while the slash-command palette is mounted in the InputBar. App-level
 *  Tab handlers gate on this so palette-Tab (accept selection) doesn't double
 *  with stream-focus Tab. */
export const slashPaletteOpen = signal<boolean>(false);
export const reverseSearchOpen = signal<boolean>(false);

/** Windowed content rows of the chat input's current draft (≥ 1), reported
 * by `InputBar`. The row allocator budgets the input bar from this instead of
 * assuming the single-line height, so a multi-line draft shrinks the
 * transcript rather than growing the live frame past the terminal. */
export const inputBarContentRows = signal<number>(1);

// ---------------------------------------------------------------------------
// transientNoticeSlice
// ---------------------------------------------------------------------------

/** Regenerable status-bar text with explicit behavior for exit confirmation. */
export type TransientNotice =
  | {
      readonly kind: 'message';
      readonly text: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: 'exit';
      readonly text: string;
      readonly resumeId?: string;
      readonly expiresAt: number;
    };

type TransientNoticeOptions =
  | { readonly kind?: 'message'; readonly ttlMs?: number }
  | {
      readonly kind: 'exit';
      readonly resumeId?: string;
      readonly ttlMs?: number;
    };

const DEFAULT_TRANSIENT_NOTICE_TTL_MS = 4_000;

/** Single status-bar notice slot; later notices replace earlier ones. */
export const transientNotice = signal<TransientNotice | undefined>(undefined);
let transientNoticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a regenerable status-bar notice for a bounded interval.
 *
 * `ttlMs: Infinity` makes the notice sticky — it stays until replaced by a
 * later notice or cleared explicitly. Error reports use this: a 4-second
 * auto-dismiss is a silent failure for anyone who glances away, and the
 * single-slot model already bounds how long a stale notice can linger. */
export function setTransientNotice(
  text: string,
  options: TransientNoticeOptions = {},
): void {
  const ttlMs = options.ttlMs ?? DEFAULT_TRANSIENT_NOTICE_TTL_MS;
  const expiresAt = Date.now() + ttlMs;
  const singleLineText = text.replaceAll(/[ \t]*\r?\n[ \t]*/g, ' · ').trim();
  const notice: TransientNotice =
    options.kind === 'exit'
      ? {
          kind: 'exit',
          text: singleLineText,
          expiresAt,
          resumeId: options.resumeId,
        }
      : { kind: 'message', text: singleLineText, expiresAt };
  if (transientNoticeTimer) clearTimeout(transientNoticeTimer);
  transientNotice.set(notice);
  if (!Number.isFinite(ttlMs)) {
    transientNoticeTimer = undefined;
    return;
  }
  transientNoticeTimer = setTimeout(() => {
    if (transientNotice.get() === notice) {
      transientNotice.set(undefined);
      transientNoticeTimer = undefined;
    }
  }, ttlMs);
  transientNoticeTimer.unref?.();
}

/** Remove the current status-bar notice, including its pending expiry timer. */
export function clearTransientNotice(): void {
  if (transientNoticeTimer) clearTimeout(transientNoticeTimer);
  transientNoticeTimer = undefined;
  transientNotice.set(undefined);
}

// ---------------------------------------------------------------------------
// codexPreferenceSlice
// ---------------------------------------------------------------------------

// Bumped whenever an in-process subscription preference changes (ChatGPT/Grok)
// so the status bar re-reads it immediately instead of waiting for its periodic
// poll. External changes (extension/desktop/config edits) are still picked up by
// that poll.

export const codexPreferenceVersion = signal<number>(0);

/** Signal the status bar to re-read subscription preferences now. */
export function bumpCodexPreferenceVersion(): void {
  codexPreferenceVersion.set(codexPreferenceVersion.get() + 1);
}

// ---------------------------------------------------------------------------
// removeStream
// ---------------------------------------------------------------------------

// Cross-slice cleanup when a stream goes away: drops it from the streams map,
// clears focus if it was active, and tombstones the stream identity in the
// child-stream relationship map (childExecutions.ts) so no later roster,
// edge, attachment, or status fact for it — or, if it was itself a parent,
// for its former children — can resurrect it.

export function removeStream(streamId: StreamTabId): void {
  const current = streams.get();
  if (current.has(streamId)) {
    const out = new Map(current);
    out.delete(streamId);
    streams.set(out);
  }
  if (activeStreamId.get() === streamId) {
    activeStreamId.set(undefined);
  }
  if (FOREGROUND_READER.get()?.streamId === streamId) {
    FOREGROUND_READER.set(undefined);
  }
  applyChildStreamRemoval(streamId);
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

// Full-state reset between CLI sessions (e.g. `/clear`), plus the hook
// registry other state modules use to reset their own signals in step.

const RESET_HOOKS = new Set<() => void>();
let CLI_STATE_GENERATION = 0;

/** Identity of the current signal-state lifetime for asynchronous subscribers. */
export function getCliStateGeneration(): number {
  return CLI_STATE_GENERATION;
}

export function registerCliStateResetHook(resetHook: () => void): () => void {
  RESET_HOOKS.add(resetHook);
  return () => RESET_HOOKS.delete(resetHook);
}

/** Submit-side state for the one active slash form. */
export interface FormProgress {
  readonly token: symbol;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly title: string;
  readonly message?: string;
  readonly copyableMessage?: string;
  readonly archivedCopyableMessage?: string;
  readonly archiveCopyable?: () => void;
  readonly cancel: () => void;
  readonly dismiss: () => void;
}

export const formProgress = signal<FormProgress | undefined>(undefined);
registerCliStateResetHook(() => formProgress.set(undefined));

export function resetCliState(
  nextSessionMeta: SessionMeta = defaultSessionMeta(),
): void {
  CLI_STATE_GENERATION += 1;
  RETIRED_STREAMS.clear();
  for (const streamId of streams.get().keys()) RETIRED_STREAMS.add(streamId);
  sessionMeta.set(nextSessionMeta);
  activeStreamId.set(undefined);
  rootStreamId.set(undefined);
  streams.set(new Map());
  rootRunStartAvailable.set(true);
  rootRunPending.set(false);
  rootRunStreamId.set(undefined);
  resetChildStreamEntries();
  activeForm.set(undefined);
  INFO_PANE_QUEUE.set([]);
  FOREGROUND_READER.set(undefined);
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  clearTransientNotice();
  for (const resetHook of RESET_HOOKS) resetHook();
}

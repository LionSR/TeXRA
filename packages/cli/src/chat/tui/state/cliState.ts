/**
 * CLI TUI shared signal store. All view-level state (streams, session,
 * focus, overlays, exit hints) lives here as signals.
 */
import { computed, signal, type Signal } from '@lit-labs/signals';
import type { StreamPhaseState } from '@agent/runtime';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type {
  AgentDelegationScope,
  StreamLogEntry,
  StreamTabId,
  TaskGroup,
  WorkflowPlanMarker,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type {
  CompactionActivityBlock,
  CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import type { StreamArtifactAuthority } from '@transcript';
import { isChildStreamRemoved, sessionStreamPhase } from './childExecutions';
import type { PastedImageEntry } from '../input/draftAttachments';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

// Data model for the CLI TUI's signal-backed state. Mirrors the webview's
// `progressState` shape — same primitives (`@lit-labs/signals`), same shape
// (one record per stream + an `activeStreamId`) so future feature parity is a
// port, not a rewrite.

/**
 * One transcript-projection candidate: a rendered row plus the ordering key
 * that places it in the final merged transcript order (log rows by seqNo,
 * compaction rows by start position, CLI-synthetic rows by their insertion
 * anchor). `rank` preserves the relative order of equal keys across the three
 * sources. `rendered` is replaced in place when the source row changes or the
 * settled-prefix promotion reaches it; the item object itself is stable.
 */
export interface TranscriptFoldItem {
  rendered: TranscriptRow;
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

/** Incremental declared-plan memo: the newest `workflowPlan` marker in
 *  transcript order, kept the same way as the task-group memo. */
interface WorkflowPlanProjectionState {
  readonly applied: Map<string, StreamLogEntry>;
  snapshot: WorkflowPlanMarker | undefined;
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
  /** Projection-mode bit `items` was built under; a flip forces a rebuild. */
  projectLifecycleToTaskGroups: boolean;
  /** Local rows reconciled into `items`, in slice order, by identity. */
  synthetics: readonly TranscriptRow[];
  /** Incremental task-group / compaction memos. Unlike the fold fields above
   *  they are NOT cleared by a fold rebuild (each is self-consistent against
   *  a full replay); they are dropped only when the stream's transcript
   *  residency is released, and die with the slice like everything here. */
  taskGroupProjection?: TaskGroupProjectionState;
  compactionProjection?: CompactionProjectionState;
  workflowPlanProjection?: WorkflowPlanProjectionState;
  /** Whether the last emitted `entries` was the full transcript or compact;
   *  undefined until the first emission. */
  lastOutputFull?: boolean;
  /** The exact `entries` array last emitted. A slice whose entries no longer
   *  match was patched out of band (local rows), so the next application
   *  must rebuild its output instead of reusing `slice.entries`. */
  lastEntriesOutput?: readonly TranscriptRow[];
}

export interface SessionMeta {
  readonly agent: string;
  readonly category: AgentCategory;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
  readonly cwd: string;
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

/**
 * CLI-only per-stream view state. Everything the shared substrate owns —
 * identity/config/description metadata (`streamMetadataFor`), lifecycle phase,
 * substate and run-window start (`streamPhaseFor`), conversation progress and
 * stage (`streamStateFor`), workflow artifacts and cumulative usage
 * (`readStreamArtifacts`/`StreamArtifactProjection`), queued follow-ups
 * (`queuedFollowUpsFor`) — is read from it at paint and has no field here.
 * What remains is transcript-rail projection output (the fold rail stays
 * separate from the fact rail by design) and terminal modality.
 */
export interface StreamSlice {
  readonly streamId: StreamTabId;
  /** Run/round/phase lifecycle projected from the canonical StreamLog. */
  readonly taskGroups: readonly TaskGroup[];
  /** The newest attempt's declared phases and tasks, from the transcript's
   *  `workflowPlan` marker; undefined until a workflow-script run records
   *  one. What the dashboard lists that the run has not reached yet. */
  readonly workflowPlan: WorkflowPlanMarker | undefined;
  /** CLI-only live status: the newest meaningful transcript line for this
   *  stream, recomputed on every log sync. Fills the stream-list summary slot
   *  until the runtime supplies a `description`. */
  readonly latestLine: string | undefined;
  /** True while the latest hidden provider-side reasoning/thinking stream is
   *  the current live activity. The CLI never renders the content directly;
   *  this only drives a lightweight liveness indicator. */
  readonly thinkingActive: boolean;
  /** True while the runtime is summarizing prior conversation context. */
  readonly compactingActive: boolean;
  readonly entries: readonly TranscriptRow[];
  /** How far the append-only `<Static>` promotion has reached in `entries`:
   *  rows before this index have been printed to terminal scrollback and can
   *  never be taken back. This is the only home of that fact — a row's own
   *  immutability is read off the row (`isSelfSettledRow`), and the two
   *  together answer "is this row finalized" (`isFinalizedTranscriptRow`). */
  readonly finalizedFrontier: number;
  /** Transcript-projection working state (see {@link TranscriptFoldState}).
   *  A mutable box owned by `subscribeStreamLog`; renderers ignore it. */
  readonly transcriptFold?: TranscriptFoldState;
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
    latestLine: undefined,
    taskGroups: [],
    workflowPlan: undefined,
    thinkingActive: false,
    compactingActive: false,
    entries: [],
    finalizedFrontier: 0,
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

/** Patch one stream's view state. */
export function patchStream(
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): void {
  RETIRED_STREAMS.delete(streamId);
  const current = streams.get();
  const slice = current.get(streamId) ?? emptySlice(streamId);
  const next = update(slice);
  if (next === slice) return;
  const out = new Map(current);
  out.set(streamId, next);
  streams.set(out);
}

/** Whether this stream identity is still live in the current state lifetime.
 *  A stream tombstoned by `removeStream`, or retired by `resetCliState`, is
 *  final: it accepts no further status, folds no log, and paints no phase. */
export function cliStreamAcceptsStatus(streamId: StreamTabId): boolean {
  return !isChildStreamRemoved(streamId) && !RETIRED_STREAMS.has(streamId);
}

/**
 * Lifecycle state for a stream at paint: phase, substate, and the run-window
 * start elapsed time is rendered from, all read from the session's status
 * machine — the single owner that stamps them and writes its entry before
 * publishing the matching `status` fact.
 *
 * Gated on this state lifetime holding a slice for the identity, which is how
 * the removed/retired rule the deleted status mirror enforced still holds: the
 * machine remembers the last phase of a stream `removeStream` dropped or
 * `resetCliState` retired, and no slice means no paint.
 */
export function streamPhaseFor(
  streamId: StreamTabId | undefined,
): StreamPhaseState | undefined {
  if (streamId === undefined || !streams.get().has(streamId)) return undefined;
  return sessionStreamPhase(streamId);
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
interface WorkPlanReaderRequest {
  readonly revision: number;
  readonly streamId: StreamTabId;
}

type ForegroundReaderTarget =
  | { readonly kind: 'transcript'; readonly streamId: StreamTabId }
  | { readonly kind: 'workflow'; readonly streamId: StreamTabId }
  | {
      readonly kind: 'workPlan';
      readonly streamId: StreamTabId;
      readonly loading?: false;
      readonly authority?: Pick<StreamArtifactAuthority, 'plan' | 'todos'>;
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

/** The counted groups a workflow phase's quiet rows collapse into. */
export type WorkflowPopupGroupKind = 'queued' | 'done' | 'declared';

/** View state of the workflow popup — which phase tab is open, which row is
 *  highlighted, which counted groups are unfolded, and the live filter. Held
 *  here rather than in the component so a repaint or a foreground surface
 *  taking over (an approval) hands the popup back exactly as it was. */
export interface WorkflowPopupView {
  readonly phaseIndex: number;
  readonly selectedKey: string | undefined;
  readonly expanded: ReadonlySet<WorkflowPopupGroupKind>;
  /** Live filter text; empty means none. */
  readonly filter: string;
  /** True while keystrokes edit the filter instead of moving the selection. */
  readonly filterEditing: boolean;
}

const INITIAL_WORKFLOW_POPUP_VIEW: WorkflowPopupView = {
  phaseIndex: 0,
  selectedKey: undefined,
  expanded: new Set(),
  filter: '',
  filterEditing: false,
};

/** The view belongs to the workflow stream, not to the mounted reader:
 *  closing the popup to look at one of its agents and coming back lands
 *  where the user left it; only a different workflow starts fresh. */
const WORKFLOW_POPUP_VIEW = signal<{
  readonly streamId: StreamTabId | undefined;
  readonly view: WorkflowPopupView;
}>({ streamId: undefined, view: INITIAL_WORKFLOW_POPUP_VIEW });
export const workflowPopupView: Signal.Computed<WorkflowPopupView> = computed(
  () => WORKFLOW_POPUP_VIEW.get().view,
);

/** Open the workflow popup on a workflow-script stream. A workflow is never
 *  a viewport: this is the one way to look inside one (see
 *  `presentStream`). */
export function openWorkflowPopup(streamId: StreamTabId): void {
  if (WORKFLOW_POPUP_VIEW.get().streamId !== streamId) {
    WORKFLOW_POPUP_VIEW.set({ streamId, view: INITIAL_WORKFLOW_POPUP_VIEW });
  }
  FOREGROUND_READER.set({ kind: 'workflow', streamId });
}

export function updateWorkflowPopupView(
  patch: Partial<WorkflowPopupView>,
): void {
  const current = WORKFLOW_POPUP_VIEW.get();
  WORKFLOW_POPUP_VIEW.set({ ...current, view: { ...current.view, ...patch } });
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
  authority?: Pick<StreamArtifactAuthority, 'plan' | 'todos'>,
): boolean {
  if (!workPlanReaderRequestIsCurrent(request)) return false;
  FOREGROUND_READER.set({
    kind: 'workPlan',
    streamId: request.streamId,
    ...(authority ? { authority } : {}),
  });
  return true;
}

/** Promote fields whose provenance was established after a partial `/plan`
 * load. Live writes and later successful preloads must replace the reader's
 * failure-time mask rather than leaving a now-current field unavailable. */
export function establishWorkPlanReaderAuthority(
  streamId: StreamTabId,
  fields: readonly (keyof Pick<StreamArtifactAuthority, 'plan' | 'todos'>)[],
): void {
  const target = FOREGROUND_READER.get();
  if (
    target?.kind !== 'workPlan' ||
    target.loading === true ||
    target.streamId !== streamId ||
    target.authority === undefined
  ) {
    return;
  }
  const authority = { ...target.authority };
  let changed = false;
  for (const field of fields) {
    if (!authority[field]) {
      authority[field] = true;
      changed = true;
    }
  }
  if (!changed) return;
  FOREGROUND_READER.set(
    authority.plan && authority.todos
      ? { kind: 'workPlan', streamId }
      : { ...target, authority },
  );
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

/** Refused follow-ups handing their submitted drafts back to the InputBar.
 * Requests stay ordered until the InputBar atomically drains the whole batch. */
interface DraftRestoreRequest {
  readonly text: string;
  readonly images: readonly PastedImageEntry[];
}
export const draftRestoreRequest = signal<readonly DraftRestoreRequest[]>([]);
export function requestDraftRestore(
  text: string,
  images: readonly PastedImageEntry[] = [],
): void {
  draftRestoreRequest.set([
    ...draftRestoreRequest.get(),
    { text, images: [...images] },
  ]);
}

export function takeDraftRestoreRequests(): readonly DraftRestoreRequest[] {
  const requests = draftRestoreRequest.get();
  if (requests.length > 0) draftRestoreRequest.set([]);
  return requests;
}

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

// Cross-slice cleanup when a stream goes away: drops it from the streams map
// and clears focus if it was active. The removal tombstone itself — what
// refuses later roster, edge, attachment, and status facts for the identity —
// is owned by the shared `SessionState` (the applier installs it before this
// runs), not by CLI view state.

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
  /** Whether `copyableMessage` has already been written to scrollback by `archiveCopyable`. */
  readonly copyableMessageArchived?: boolean;
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
  rootRunPending.set(false);
  rootRunStreamId.set(undefined);
  activeForm.set(undefined);
  INFO_PANE_QUEUE.set([]);
  FOREGROUND_READER.set(undefined);
  WORKFLOW_POPUP_VIEW.set({
    streamId: undefined,
    view: INITIAL_WORKFLOW_POPUP_VIEW,
  });
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  draftRestoreRequest.set([]);
  clearTransientNotice();
  for (const resetHook of RESET_HOOKS) resetHook();
}

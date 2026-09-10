/**
 * CLI TUI shared signal store. All view-level state (runs, session,
 * focus, overlays, exit hints) lives here as signals.
 */
import { computed, signal, type Signal } from '@lit-labs/signals';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  AgentCategory,
  type AgentDelegationScope,
  type RunId,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { RUN_GROUP_LABELS } from '@shared/runs/runStatusDisplay';
import type { WorkflowRowGroup } from '@shared/runs/workflowRunModel';
import { sessionView } from './sessionView';
import type { PastedImageEntry } from '../input/draftAttachments';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

// Data model for the CLI TUI's signal-backed state. Mirrors the webview's
// `progressState` shape — same primitives (`@lit-labs/signals`), same shape
// (one record per stream + an `activeRunId`) so future feature parity is a
// port, not a rewrite.

/**
 * One transcript-projection candidate: a rendered row plus the ordering key
 * that places it in the final merged transcript order (log rows by seqNo,
 * compaction rows by start position, CLI-synthetic rows by their insertion
 * anchor). `rank` preserves the relative order of equal keys across the three
 * sources. `rendered` is replaced in place when the source row changes or the
 * settled-prefix promotion reaches it; the item object itself is stable.
 */
export interface SessionMeta {
  readonly agent: string;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly approvalPolicy: TexraApprovalPolicy;
  readonly teamName?: string;
  readonly cliMultiAgentPresetId?: string;
  readonly delegationAgentScope?: AgentDelegationScope;
  readonly version: string;
}

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  model: '',
  modelSource: 'builtin-default',
  cwd: '',
  approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
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
    version: current.version,
  };
}

// ---------------------------------------------------------------------------
// focusSlice
// ---------------------------------------------------------------------------

// Which stream is focused / rooted, and whether starting a new root run is
// currently available. Focus moves only through `focusRun`;
// stream-lifecycle side effects that touch these signals alongside others
// (e.g. `removeRun`) live in the `removeRun` section below.

/** The Surface's selection as written by `focusRun`; renders read
 *  `selectedRunId`, which resolves it against the view. */
export const activeRunId = signal<RunId | undefined>(undefined);

/**
 * The stream the transcript and status bar show: the Surface's selection
 * resolved against the view (PRD 9). The selected stream while the view
 * holds it; the first top-level stream once it has left; the selection
 * itself while the view holds no stream at all (the pre-run local
 * conversation is a Surface-only id). A computed rather than an effect that
 * clears a stale selection, and a signal rather than a per-render derivation
 * so every component reads one answer.
 */
export const selectedRunId: Signal.Computed<RunId | undefined> = computed(
  () => {
    const selected = activeRunId.get();
    const view = sessionView().get();
    if (selected === undefined || view.runs.has(selected)) return selected;
    return view.runs.size === 0 ? selected : view.order.at(0);
  },
);

/**
 * Move transcript/status focus onto a stream. Sole focus writer: a stream
 * identity tombstoned by `removeRun`, or retired by `resetCliState`, is
 * never focused, so a fact that arrives after the row is gone cannot pull the
 * view onto a stream that no longer exists. `onlyIfUnset` is for the facts
 * that adopt focus only while nothing holds it (the first log sync, the first
 * local transcript row).
 */
export function focusRun(
  runId: RunId,
  options: { readonly onlyIfUnset?: boolean } = {},
): void {
  if (options.onlyIfUnset && activeRunId.get() !== undefined) return;
  activeRunId.set(runId);
}

/** Expansion is a Surface choice; the fold's forceExpanded takes precedence. */
export const expandedRuns = signal<ReadonlyMap<RunId, boolean>>(new Map());

export type SessionListRow =
  | {
      readonly kind: 'group';
      readonly label: string;
    }
  | {
      readonly kind: 'stream';
      readonly stream: RunView;
      readonly depth: number;
      readonly expanded: boolean;
    };

/** The visible tree, including section headings, shared by the list and its shortcuts. */
export const sessionListRows = computed<readonly SessionListRow[]>(() => {
  const view = sessionView().get();
  const expanded = expandedRuns.get();
  const rows: SessionListRow[] = [];
  const groups: Record<RunView['group'], RunView[]> = {
    running: [],
    waiting: [],
    interrupted: [],
    recent: [],
  };
  for (const id of view.order) {
    const stream = view.runs.get(id)!;
    groups[stream.group].push(stream);
  }
  const append = (stream: RunView, depth: number): void => {
    const open =
      stream.category !== AgentCategory.Workflow &&
      (stream.forceExpanded || expanded.get(stream.id) === true);
    rows.push({ kind: 'stream', stream, depth, expanded: open });
    // A workflow's calls belong to its existing popup.
    if (open) {
      for (const id of stream.childIds) append(view.runs.get(id)!, depth + 1);
    }
  };
  for (const runs of Object.values(groups)) {
    const first = runs.at(0);
    if (!first) continue;
    rows.push({ kind: 'group', label: RUN_GROUP_LABELS[first.group] });
    for (const stream of runs) append(stream, 0);
  }
  return rows;
});

/** Stream shortcuts follow the visible tree and skip section headings. */
export const sessionListRunIds = computed(() =>
  sessionListRows
    .get()
    .flatMap((row) => (row.kind === 'stream' ? [row.stream.id] : [])),
);

/** The top-level stream the current session rooted at. */
export const rootRunId = signal<RunId | undefined>(undefined);
/** Whether the root session holds an unfinished run claim (run promise
 *  pending). Published only by `TuiSession`, so renders read the session
 *  run-state reactively instead of calling impure session closures that
 *  memoized renders would cache stale (#8273). */
export const rootRunPending = signal<boolean>(false);
/** Run-control mirror of `TuiSession.runId` — cleared while a new run is
 *  pending, unlike `rootRunId`, which stays put as the transcript anchor
 *  across pending windows. Published only by `TuiSession`. */
export const claimedRunId = signal<RunId | undefined>(undefined);

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

/** Session-local approval scope captured by the next Run as Goal action. */
export const goalAutoApproveAll = signal(false);

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
  readonly runId: RunId;
}

type ForegroundReaderTarget =
  | { readonly kind: 'transcript'; readonly runId: RunId }
  | { readonly kind: 'workflow'; readonly runId: RunId }
  | {
      readonly kind: 'workPlan';
      readonly runId: RunId;
      readonly loading?: false;
    }
  | {
      readonly kind: 'workPlan';
      readonly runId: RunId;
      readonly loading: true;
      readonly requestRevision: number;
    };

const FOREGROUND_READER = signal<ForegroundReaderTarget | undefined>(undefined);
let WORK_PLAN_REQUEST_REVISION = 0;
/** The open reader, resolved against the view like the selection: a reader
 *  whose stream has left the view is closed. */
export const foregroundReader: Signal.Computed<
  ForegroundReaderTarget | undefined
> = computed(() => {
  const reader = FOREGROUND_READER.get();
  return reader !== undefined && sessionView().get().runs.has(reader.runId)
    ? reader
    : undefined;
});

export function openTranscriptReader(runId: RunId): void {
  FOREGROUND_READER.set({ kind: 'transcript', runId });
}

/** View state of the workflow popup — which phase tab is open, which row is
 *  highlighted, which counted groups are unfolded, and the live filter. Held
 *  here rather than in the component so a repaint or a foreground surface
 *  taking over (an approval) hands the popup back exactly as it was. */
export interface WorkflowPopupView {
  readonly phaseIndex: number;
  readonly selectedKey: string | undefined;
  readonly expanded: ReadonlySet<WorkflowRowGroup>;
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
  readonly runId: RunId | undefined;
  readonly view: WorkflowPopupView;
}>({ runId: undefined, view: INITIAL_WORKFLOW_POPUP_VIEW });
export const workflowPopupView: Signal.Computed<WorkflowPopupView> = computed(
  () => WORKFLOW_POPUP_VIEW.get().view,
);

/** Open the workflow popup on a workflow-script stream. A workflow is never
 *  a viewport: this is the one way to look inside one (see
 *  `presentRun`). */
export function openWorkflowPopup(runId: RunId): void {
  if (WORKFLOW_POPUP_VIEW.get().runId !== runId) {
    WORKFLOW_POPUP_VIEW.set({ runId, view: INITIAL_WORKFLOW_POPUP_VIEW });
  }
  FOREGROUND_READER.set({ kind: 'workflow', runId });
}

export function updateWorkflowPopupView(
  patch: Partial<WorkflowPopupView>,
): void {
  const current = WORKFLOW_POPUP_VIEW.get();
  WORKFLOW_POPUP_VIEW.set({ ...current, view: { ...current.view, ...patch } });
}

/** Capture one `/plan` invocation as the sole owner of async reader output. */
export function beginWorkPlanReaderRequest(
  runId: RunId,
): WorkPlanReaderRequest {
  const request = { runId, revision: ++WORK_PLAN_REQUEST_REVISION };
  FOREGROUND_READER.set({
    kind: 'workPlan',
    runId,
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
    target.runId === request.runId &&
    target.requestRevision === request.revision
  );
}

/** Resolve the loading reader without allowing an older request to replace it. */
export function finishWorkPlanReaderRequest(
  request: WorkPlanReaderRequest,
): boolean {
  if (!workPlanReaderRequestIsCurrent(request)) return false;
  FOREGROUND_READER.set({
    kind: 'workPlan',
    runId: request.runId,
  });
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

const RESET_HOOKS = new Set<() => void>();

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
  sessionMeta.set(nextSessionMeta);
  activeRunId.set(undefined);
  rootRunId.set(undefined);
  expandedRuns.set(new Map());
  rootRunPending.set(false);
  claimedRunId.set(undefined);
  activeForm.set(undefined);
  goalAutoApproveAll.set(false);
  INFO_PANE_QUEUE.set([]);
  FOREGROUND_READER.set(undefined);
  WORKFLOW_POPUP_VIEW.set({
    runId: undefined,
    view: INITIAL_WORKFLOW_POPUP_VIEW,
  });
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  draftRestoreRequest.set([]);
  clearTransientNotice();
  for (const resetHook of RESET_HOOKS) resetHook();
}

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
  RunIdSchema,
  type AgentDelegationScope,
  type AgentSource,
  type RunId,
} from '@shared/schemas';
import { descendantRuns, type RunView } from '@shared/session/sessionView';
import {
  applySurfaceAction,
  emptySurface,
  pruneSurface,
  type SelectionRule,
  type Surface,
  type SurfaceAction,
} from '@shared/session/surface';
import { RUN_GROUP_LABELS } from '@shared/runs/runStatusDisplay';
import { compareByNewestCreationTime } from '@shared/runs/runOrdering';
import { sessionView } from './sessionView';
import type { PastedImageEntry } from '../input/draftAttachments';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

// Data model for the CLI TUI's signal-backed state. Mirrors the webview's
// interaction record: the selection and expansion live in the shared
// `Surface`, dispatched through `applySurfaceAction`.

export interface SessionMeta {
  readonly agent: string;
  /** The source of the entry `agent` resolved to, pinned on every root run. */
  readonly agentSource?: AgentSource;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly approvalPolicy: TexraApprovalPolicy;
  readonly teamName?: string;
  readonly cliTeamId?: string;
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

// Which run is focused and which one the session is rooted at. Focus moves
// only through `focusRun`.

/**
 * Where notices land before the root run exists. A reserved 8-hex id: real
 * run ids are 12 hex (generated) or 24 (derived), so it can never collide,
 * and it is minted through the schema rather than forged with a cast.
 */
export const CLI_LOCAL_RUN_ID = RunIdSchema.parse('c1110ca1');

/** The chat's interaction record: the shared `Surface`, written only through
 *  `actOnSurface`, the vocabulary the webview and desktop dispatch too. */
const surfaceChoice = signal<Surface>(emptySurface('cli'));

export function actOnSurface(action: SurfaceAction): void {
  surfaceChoice.set(applySurfaceAction(surfaceChoice.get(), action));
}

/** The chat's selection rule, its tree scope: this conversation and the runs
 *  this terminal owns. The pre-run placeholder stays; anything else outside
 *  the scope, or nothing, lands on the root. */
function chatSelection(): SelectionRule {
  const included = sessionRunIds.get();
  const root = rootRunId.get();
  const fallback = root !== undefined && included.has(root) ? root : null;
  return (selected) =>
    selected === CLI_LOCAL_RUN_ID ||
    (selected !== null && included.has(selected))
      ? selected
      : fallback;
}

/** The record the TUI renders, pruned once; no reader resolves it again. */
const surface: Signal.Computed<Surface> = computed(() => {
  const view = sessionView().get();
  return pruneSurface(surfaceChoice.get(), view, chatSelection());
});

/** The Surface's selection in the TUI's `undefined`-for-none spelling. */
export const selectedRunId: Signal.Computed<RunId | undefined> = computed(
  () => surface.get().selected ?? undefined,
);

/** The one writer of `select`. `when` adopts a selection only from a prior
 *  choice: `unset` (nothing holds it) or `local` (the pre-run placeholder). */
export function focusRun(
  runId: RunId | null,
  options: { readonly when?: 'unset' | 'local' } = {},
): void {
  const chosen = surfaceChoice.get().selected;
  if (options.when === 'unset' && chosen !== null) return;
  if (options.when === 'local' && chosen !== CLI_LOCAL_RUN_ID) return;
  actOnSurface({ kind: 'select', runId });
}

export type SessionListRow =
  | {
      readonly kind: 'group';
      readonly label: string;
    }
  | {
      readonly kind: 'run';
      readonly run: RunView;
      readonly depth: number;
      readonly expanded: boolean;
    };

/** The visible tree, including section headings, shared by the list and its shortcuts. */
export const sessionListRows = computed<readonly SessionListRow[]>(() => {
  const view = sessionView().get();
  const included = sessionRunIds.get();
  const { expanded } = surface.get();
  const rows: SessionListRow[] = [];
  const groups: Record<RunView['group'], RunView[]> = {
    running: [],
    waiting: [],
    interrupted: [],
    recent: [],
  };
  // Top-level runs come in the fold's order. A child this terminal owns
  // under a parent outside the scope (detached from an earlier turn) is a
  // root here but not in `view.order`: only these sort, after the fold's.
  const tops = view.order.flatMap((id) => view.runs.get(id) ?? []);
  const detached = [...view.runs.values()].filter(
    (run) =>
      run.parentId !== null &&
      included.has(run.id) &&
      !included.has(run.parentId),
  );
  detached.sort((a, b) =>
    compareByNewestCreationTime(
      { name: a.id, creationTimestamp: a.createdAt },
      { name: b.id, creationTimestamp: b.createdAt },
    ),
  );
  for (const run of [...tops, ...detached]) {
    if (included.has(run.id)) groups[run.group].push(run);
  }
  const append = (run: RunView, depth: number): void => {
    const open = run.forceExpanded || expanded.get(run.id) === true;
    rows.push({ kind: 'run', run, depth, expanded: open });
    if (open) {
      for (const id of run.childIds) {
        if (included.has(id)) append(view.runs.get(id)!, depth + 1);
      }
    }
  };
  for (const runs of Object.values(groups)) {
    const first = runs.at(0);
    if (!first) continue;
    rows.push({ kind: 'group', label: RUN_GROUP_LABELS[first.group] });
    for (const run of runs) append(run, 0);
  }
  return rows;
});

/** Run shortcuts follow the visible tree and skip section headings. */
export const sessionListRunIds = computed(() =>
  sessionListRows
    .get()
    .flatMap((row) => (row.kind === 'run' ? [row.run.id] : [])),
);

/** The top-level run the current session rooted at. */
export const rootRunId = signal<RunId | undefined>(undefined);

/** The root run and every run under it. */
export const rootRunIds = computed(() =>
  descendantRuns(sessionView().get(), rootRunId.get(), { includeRoot: true }),
);

/** The current conversation and all runs this terminal still owns,
 *  including children detached from an earlier turn. */
export const sessionRunIds = computed((): ReadonlySet<RunId> => {
  const included = new Set(rootRunIds.get());
  for (const run of sessionView().get().runs.values()) {
    if (run.ownedHere) included.add(run.id);
  }
  return included;
});

// ---------------------------------------------------------------------------
// foregroundOverlaySlice
// ---------------------------------------------------------------------------

// Signals for the App-level foreground surfaces: the inline slash form,
// slash-command palette, and reverse search. These view-level toggles live
// here as signal state rather than local component state.

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

/** Passive reader target. Holding the captured run id rather than a text
 * snapshot keeps each reader live even if transcript focus moves elsewhere. */
type ForegroundReaderTarget =
  | { readonly kind: 'transcript'; readonly runId: RunId }
  | { readonly kind: 'script'; readonly runId: RunId }
  | { readonly kind: 'workPlan'; readonly runId: RunId };

const FOREGROUND_READER = signal<ForegroundReaderTarget | undefined>(undefined);
/** The open reader, resolved against the view like the selection: a reader
 *  whose run has left the view is closed. */
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

/** View state of the script popup: which of the run's scripts it shows
 *  (unset, the newest) and the highlighted call. Held here, not in the
 *  component, so a repaint or a foreground surface taking over (an
 *  approval) hands the popup back exactly as it was. */
export interface ScriptPopupView {
  readonly stageId: string | undefined;
  readonly selectedId: string | undefined;
}

const INITIAL_SCRIPT_POPUP_VIEW: ScriptPopupView = {
  stageId: undefined,
  selectedId: undefined,
};

/** Held per run: closing it to look at a call's child and coming back
 *  lands where the user left it. */
const SCRIPT_POPUP_VIEW = signal<{
  readonly runId: RunId | undefined;
  readonly view: ScriptPopupView;
}>({ runId: undefined, view: INITIAL_SCRIPT_POPUP_VIEW });
export const scriptPopupView: Signal.Computed<ScriptPopupView> = computed(
  () => SCRIPT_POPUP_VIEW.get().view,
);

/** Open the script popup on the scripts a run's transcript holds. */
export function openScriptPopup(runId: RunId): void {
  if (SCRIPT_POPUP_VIEW.get().runId !== runId) {
    SCRIPT_POPUP_VIEW.set({ runId, view: INITIAL_SCRIPT_POPUP_VIEW });
  }
  FOREGROUND_READER.set({ kind: 'script', runId });
}

export function updateScriptPopupView(patch: Partial<ScriptPopupView>): void {
  const current = SCRIPT_POPUP_VIEW.get();
  SCRIPT_POPUP_VIEW.set({ ...current, view: { ...current.view, ...patch } });
}

export function openWorkPlanReader(runId: RunId): void {
  FOREGROUND_READER.set({ kind: 'workPlan', runId });
}

export function closeForegroundReader(): void {
  FOREGROUND_READER.set(undefined);
}

/** True while the slash-command palette is mounted in the InputBar. App-level
 *  Tab handlers gate on this so palette-Tab (accept selection) doesn't double
 *  with run-focus Tab. */
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
  | { readonly kind: 'message'; readonly text: string }
  | {
      readonly kind: 'exit';
      readonly text: string;
      readonly resumeId?: string;
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

/** Why the session view stopped updating (the fold died), once it has: the
 *  composer is closed on it, since nothing typed could be shown again. */
export const sessionViewFailure = signal<string | undefined>(undefined);
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
  const singleLineText = text.replaceAll(/[ \t]*\r?\n[ \t]*/g, ' · ').trim();
  const notice: TransientNotice =
    options.kind === 'exit'
      ? { kind: 'exit', text: singleLineText, resumeId: options.resumeId }
      : { kind: 'message', text: singleLineText };
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

// Bumped whenever an in-process write changes model access (a subscription
// preference, a stored key, an access setting) so the status bar re-reads it
// immediately instead of waiting for its periodic
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
  readonly archiveCopyable: () => void;
  readonly cancel: () => void;
  readonly dismiss: () => void;
}

export const formProgress = signal<FormProgress | undefined>(undefined);
registerCliStateResetHook(() => formProgress.set(undefined));

export function resetCliState(
  nextSessionMeta: SessionMeta = defaultSessionMeta(),
): void {
  sessionMeta.set(nextSessionMeta);
  surfaceChoice.set(emptySurface('cli'));
  rootRunId.set(undefined);
  goalAutoApproveAll.set(false);
  INFO_PANE_QUEUE.set([]);
  FOREGROUND_READER.set(undefined);
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  draftRestoreRequest.set([]);
  clearTransientNotice();
  for (const resetHook of RESET_HOOKS) resetHook();
}

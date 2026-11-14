/**
 * CLI TUI shared signal store. All view-level state (runs, session,
 * focus, overlays, exit hints) lives here as signals.
 */
import { computed, signal, type Signal } from '@lit-labs/signals';
import { Schema } from 'effect';
import {
  APPROVAL_POLICY_DEFAULT,
  type ApprovalPolicy,
  RunIdSchema,
  type AgentSource,
  type RunId,
  descendantRuns,
  needsUser,
} from '@texra-ai/harness/schemas';
import { compareByNewestCreationTime } from '@texra-ai/harness/transcript';
import {
  applySurfaceAction,
  emptySurface,
  pruneSurface,
  shownRun,
  type SelectionRule,
  type Surface,
  type SurfaceAction,
} from '@texra/shared/session/surface';
import {
  RUN_SECTION_LABELS,
  RUN_SECTION_ORDER,
  runStatus,
} from '@ui/copy/runStatus';
import type { RunSection } from '@texra/shared/session/runStatusKey';
import { sessionView } from './sessionView';
import type { RootLaunch } from './sessionRunState';
import type { LocalNotice } from './transcript';
import type { FormSlot } from './formSlot';
import type { ApprovalSurface } from './approvalQueue';
import type {
  RunModelDecisionReason,
  AgentDelegationScope,
} from '@texra-ai/harness/host';
import type { RunView } from '@texra-ai/harness/schemas';

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
  readonly approvalPolicy: ApprovalPolicy;
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
  approvalPolicy: APPROVAL_POLICY_DEFAULT,
  version: '',
};

// ---------------------------------------------------------------------------
// chatState
// ---------------------------------------------------------------------------

/**
 * Everything one conversation of the chat holds: its display snapshot, its
 * interaction record and root, its foreground surfaces, and the facts the
 * state modules beside this one own (each module is the only writer of its
 * field). `/clear` starts a new conversation by replacing this value
 * ({@link startChat}), so nothing a conversation held outlives it and no
 * module keeps a reset of its own.
 */
interface ChatState {
  readonly meta: SessionMeta;
  readonly surface: Surface;
  readonly rootRunId: RunId | undefined;
  readonly infoPanes: readonly InfoPaneContent[];
  readonly reader: ForegroundReaderTarget | undefined;
  readonly childList: ChildListFocus;
  readonly slashPaletteOpen: boolean;
  readonly reverseSearchOpen: boolean;
  readonly notice: TransientNotice | undefined;
  readonly formProgress: FormProgress | undefined;
  readonly rootLaunch: RootLaunch | undefined;
  readonly localNotices: readonly LocalNotice[];
  readonly forms: FormSlot;
  readonly approvals: ApprovalSurface;
}

const newChatState = (meta: SessionMeta): ChatState => ({
  meta,
  surface: emptySurface('cli'),
  rootRunId: undefined,
  infoPanes: [],
  reader: undefined,
  childList: { focused: false },
  slashPaletteOpen: false,
  reverseSearchOpen: false,
  notice: undefined,
  formProgress: undefined,
  rootLaunch: undefined,
  localNotices: [],
  forms: { active: undefined, queued: [] },
  approvals: { staged: new Map(), decided: new Set(), promoted: undefined },
});

const chat = signal<ChatState>(newChatState(EMPTY_SESSION_META));

/** One field of a state record held in `source`, read (and watched) as a
 *  signal of its own and written into the record `source` holds now. */
export function fieldOf<S extends object, K extends keyof S>(
  source: { get(): S; set(value: S): void },
  key: K,
): Signal.Computed<S[K]> & { readonly set: (value: S[K]) => void } {
  return Object.assign(
    computed(() => source.get()[key]),
    { set: (value: S[K]) => source.set({ ...source.get(), [key]: value }) },
  );
}

/** One field of the chat's state, written into the current conversation. */
export const chatField = <K extends keyof ChatState>(key: K) =>
  fieldOf(chat, key);

/** Start a new conversation: the chat's state becomes a fresh value, keeping
 *  only `meta` (by default the process's version). */
export function startChat(nextMeta: SessionMeta = defaultSessionMeta()): void {
  chat.set(newChatState(nextMeta));
}

/** Reactive display snapshot for the current CLI session. */
export const sessionMeta = chatField('meta');

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
export const CLI_LOCAL_RUN_ID =
  Schema.decodeUnknownSync(RunIdSchema)('c1110ca1');

/** The chat's interaction record: the shared `Surface`, written only through
 *  `actOnSurface`, the vocabulary the webview and desktop dispatch too. */
const surfaceChoice = chatField('surface');

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
  () => shownRun(surface.get()) ?? undefined,
);

/** The one writer of `select`. `when` adopts a selection only from a prior
 *  choice: `unset` (nothing holds it) or `local` (the pre-run placeholder). */
export function focusRun(
  runId: RunId | null,
  options: { readonly when?: 'unset' | 'local' } = {},
): void {
  const chosen = shownRun(surfaceChoice.get());
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
  const { runs } = surface.get();
  const rows: SessionListRow[] = [];
  const groups: Record<RunSection, RunView[]> = {
    running: [],
    waiting: [],
    interrupted: [],
    recent: [],
  };
  // Top-level runs come in the session view's order. A child this terminal owns
  // under a parent outside the scope (detached from an earlier turn) is a
  // root here but not in `view.order`: only these sort, after the session view's.
  const tops = view.order.map((id) => {
    const run = view.runs.get(id);
    // The view's update removes a run from `order` with its entry, so a miss
    // is a broken view, not a run to leave out.
    if (run === undefined)
      throw new Error(
        `The session view orders run ${id} but holds no run for it`,
      );
    return run;
  });
  const detached = [...view.runs.values()].filter(
    (run) =>
      run.parentId !== null &&
      included.has(run.id) &&
      !included.has(run.parentId),
  );
  detached.sort(compareByNewestCreationTime);
  for (const run of [...tops, ...detached]) {
    if (included.has(run.id)) groups[runStatus(run).section].push(run);
  }
  const append = (run: RunView, depth: number): void => {
    const open =
      needsUser(run, view.runs) || runs.get(run.id)?.expanded === true;
    rows.push({ kind: 'run', run, depth, expanded: open });
    if (open) {
      for (const id of run.childIds) {
        const child = view.runs.get(id);
        if (child !== undefined && included.has(id)) append(child, depth + 1);
      }
    }
  };
  for (const section of RUN_SECTION_ORDER) {
    const runs = groups[section];
    if (runs.length === 0) continue;
    rows.push({ kind: 'group', label: RUN_SECTION_LABELS[section] });
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

/** The child list's keyboard ownership and the row the user moved to, with
 *  the run that was active when they did: a later change of the active run
 *  moves the highlight to it. */
interface ChildListFocus {
  readonly focused: boolean;
  readonly chosen?: { readonly runId: RunId; readonly whileActive?: RunId };
}
const CHILD_LIST = chatField('childList');

/**
 * The child list's highlighted row: the row the user moved to while the
 * active run has not changed since, else the active run when it is listed,
 * else (with none active) the first row. Resolved against the list on every
 * read, so a run leaving the list moves it.
 */
export const childListHighlight = computed((): RunId | undefined => {
  const listed = sessionListRunIds.get();
  const active = selectedRunId.get();
  const chosen = CHILD_LIST.get().chosen;
  if (
    chosen !== undefined &&
    listed.includes(chosen.runId) &&
    (active === undefined || active === chosen.whileActive)
  ) {
    return chosen.runId;
  }
  if (active !== undefined) return listed.includes(active) ? active : undefined;
  return listed[0];
});

/** Whether the child list owns the keys: it was given them and still lists
 *  a run. Otherwise the input does. */
export const childListFocused = computed(
  () => CHILD_LIST.get().focused && sessionListRunIds.get().length > 0,
);

/** Move the child list's highlight to `runId`. */
export function highlightChildListRun(runId: RunId): void {
  CHILD_LIST.set({
    ...CHILD_LIST.get(),
    chosen: { runId, whileActive: selectedRunId.get() },
  });
}

/** Give the child list the keys (its highlight, or its first row, stays
 *  highlighted), or hand them back to the input. */
export function focusChildList(focused: boolean): void {
  if (!focused) {
    if (CHILD_LIST.get().focused) {
      CHILD_LIST.set({ ...CHILD_LIST.get(), focused: false });
    }
    return;
  }
  const first = childListHighlight.get() ?? sessionListRunIds.get()[0];
  if (first === undefined) return;
  highlightChildListRun(first);
  CHILD_LIST.set({ ...CHILD_LIST.get(), focused: true });
}

/** The top-level run the current session rooted at. */
export const rootRunId = chatField('rootRunId');

/** The root run and every run under it. */
export const rootRunIds = computed(() =>
  descendantRuns(sessionView().get(), rootRunId.get(), { includeRoot: true }),
);

/** The current conversation and all runs this terminal still owns,
 *  including children detached from an earlier turn. */
export const sessionRunIds = computed((): ReadonlySet<RunId> => {
  const included = new Set(rootRunIds.get());
  for (const run of sessionView().get().runs.values()) {
    if (run.holder === 'here') included.add(run.id);
  }
  return included;
});

// ---------------------------------------------------------------------------
// foregroundOverlaySlice
// ---------------------------------------------------------------------------

// Signals for the App-level foreground surfaces: the inline slash form,
// slash-command palette, and reverse search. These view-level toggles live
// here as signal state rather than local component state.

interface InfoPaneContent {
  readonly title: string;
  readonly lines: readonly string[];
}

const INFO_PANE_QUEUE = chatField('infoPanes');
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

const FOREGROUND_READER = chatField('reader');
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
export const slashPaletteOpen = chatField('slashPaletteOpen');
export const reverseSearchOpen = chatField('reverseSearchOpen');

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

/** A notice's fields other than its text, `kind` defaulting to `message`. */
type TransientNoticeOptions = { readonly ttlMs?: number } & (
  | { readonly kind?: 'message' }
  | Omit<Extract<TransientNotice, { kind: 'exit' }>, 'text'>
);

const DEFAULT_TRANSIENT_NOTICE_TTL_MS = 4_000;

/** Single status-bar notice slot; later notices replace earlier ones. */
export const transientNotice = chatField('notice');

/** Why the session view stopped updating (the session view died), once it has: the
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

export const formProgress = chatField('formProgress');

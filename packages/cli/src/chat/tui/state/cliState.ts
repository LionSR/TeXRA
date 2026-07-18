/**
 * CLI TUI shared signal store. All view-level state (streams, session,
 * focus, overlays, exit hints) lives here as signals; formerly one file per
 * slice under `cliState/`.
 */
import { signal, type Signal } from '@lit-labs/signals';
import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import {
  AgentCategory,
  type ActiveChildInfo,
  type ConversationProgress,
  type MessageType,
  type NormalizedToolUse,
  type Plan,
  type ProcessOutputTail,
  type RoundStage,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';
import type { AgentDelegationScope } from '@shared/schemas/agentRoster';
import { isActivePhase } from '@shared/streams/streamStatus';
import {
  applyChildStreamRemoval,
  isChildStreamRemoved,
  resetChildStreamEntries,
} from './childExecutions';

export type { ProcessOutputTail };

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
  /** Rendered log text. Empty for tool and process rows. */
  readonly text: string;
  /** Original shared log vocabulary. Role alone intentionally groups several
   * display kinds and is not precise enough for semantic selection. */
  readonly messageType?: MessageType;
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
      readonly role: 'phase';
      /** Phase title displayed in the group-header divider row. */
      readonly phaseLabel: string;
      /** 0-based phase order within the run, when the emitter provides it. */
      readonly phaseIndex?: number;
      /** Total phase count for the run, when the emitter provides it. */
      readonly phaseTotal?: number;
    })
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
  readonly category: AgentCategory;
  readonly model: string;
  readonly modelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly apiMode: CliApiMode;
  readonly approvalPolicy: CliApprovalPolicy;
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

export interface StreamSlice {
  readonly streamId: StreamTabId;
  /** Model identity captured from setTaskState for this specific stream. */
  readonly model?: string | undefined;
  /** Agent category for this stream (`toolUse` / `workflow` / …), captured
   *  from `setTaskState` or `setActiveStream`. Lets the exit hint list only
   *  resumable tool-use subagents (workflows don't resume). */
  readonly category: AgentCategory | undefined;
  readonly status: StreamPhase | undefined;
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
  readonly activeProcesses: readonly ActiveChildInfo[];
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

export interface StreamAccessTarget {
  readonly model: string;
  readonly category: AgentCategory | undefined;
}

/**
 * Use root-session access facts only before any stream exists. Once a stream
 * exists, preserve an unknown category rather than guessing across the
 * tool-use-only subscription boundary.
 */
export function streamAccessTarget(
  stream: Pick<StreamSlice, 'model' | 'category'> | undefined,
  session: Pick<SessionMeta, 'model' | 'category'>,
): StreamAccessTarget {
  return {
    model: stream?.model ?? session.model,
    category: stream === undefined ? session.category : stream.category,
  };
}

/**
 * Shared gate for the "model is thinking" indicators (the StatusBar segment
 * and the conversation pane's liveness row) so the two can never disagree:
 * the hidden reasoning phase is only worth surfacing while the stream is
 * actually running — any final or waiting status supersedes it.
 */
export function thinkingIndicatorVisible(
  slice:
    | {
        readonly status: StreamPhase | undefined;
        readonly thinkingActive: boolean;
      }
    | undefined,
): boolean {
  return slice?.thinkingActive === true && isActivePhase(slice.status);
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
    activeProcesses: [],
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
const RETIRED_STREAMS = new Set<StreamTabId>();

/** Per-stream state map, keyed by `StreamTabId`. */
export const streams = STREAMS;

/** Whether reset retired this stream identity from the current state lifetime. */
export function isCliStreamRetired(streamId: StreamTabId): boolean {
  return RETIRED_STREAMS.has(streamId);
}

export function patchStream(
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): void {
  RETIRED_STREAMS.delete(streamId);
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
  const current = STREAMS.get();
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
  STREAMS.set(out);
  return true;
}

// ---------------------------------------------------------------------------
// sessionSlice
// ---------------------------------------------------------------------------

// Session-identity slice: the agent/model/cwd/approval snapshot for the
// current CLI session. One signal, no cross-stream concerns.

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  category: AgentCategory.ToolUse,
  model: '',
  modelSource: 'builtin-default',
  cwd: '',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  canDelegate: false,
  transcriptMode: 'persistent',
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

/** Preserve process-session properties across conversation resets. */
function defaultSessionMeta(): SessionMeta {
  const current = SESSION_META.get();
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
// currently available. No update logic beyond plain get/set lives here —
// stream-lifecycle side effects that touch these signals alongside others
// (e.g. `removeStream`) live in `./removeStream`.

const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_STREAM_ID = signal<StreamTabId | undefined>(undefined);
const ROOT_RUN_START_AVAILABLE = signal<boolean>(true);
const ROOT_RUN_PENDING = signal<boolean>(false);
const ROOT_RUN_STREAM_ID = signal<StreamTabId | undefined>(undefined);

/** The stream currently focused in the transcript / status bar. */
export const activeStreamId = ACTIVE_STREAM_ID;
/** The top-level stream the current session rooted at. */
export const rootStreamId = ROOT_STREAM_ID;
/** Whether starting a new root run is currently available. */
export const rootRunStartAvailable = ROOT_RUN_START_AVAILABLE;
/** Whether the root session holds an unfinished run claim (run promise
 *  pending). Published only by `publishChatTuiRunState`, so renders read the
 *  session run-state reactively instead of calling impure session closures
 *  that memoized renders would cache stale (#8273). */
export const rootRunPending = ROOT_RUN_PENDING;
/** Run-control mirror of `TuiSession.streamId` — cleared while a new run is
 *  pending, unlike `rootStreamId`, which stays put as the transcript anchor
 *  across pending windows. Published only by `publishChatTuiRunState`. */
export const rootRunStreamId = ROOT_RUN_STREAM_ID;

// ---------------------------------------------------------------------------
// foregroundOverlaySlice
// ---------------------------------------------------------------------------

// Signals for the App-level foreground surfaces: the inline slash form,
// slash-command palette, reverse search, and process detail. These view-level
// toggles live here as signal state rather than local component state.

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

/** Process whose captured output is open in TaskDetailView. */
const TASK_DETAIL_EXECUTION_ID = signal<string | undefined>(undefined);
export const taskDetailExecutionId = TASK_DETAIL_EXECUTION_ID;

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

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

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
  slashPaletteOpen.set(false);
  reverseSearchOpen.set(false);
  taskDetailExecutionId.set(undefined);
  pendingExitHint.set(false);
  pendingExitResumeId.set(undefined);
  for (const resetHook of RESET_HOOKS) resetHook();
}

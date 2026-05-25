// Signal-backed state for the CLI TUI. Mirrors the webview's `progressState`
// shape — same primitives (`@lit-labs/signals`), same shape (one record per
// stream + an `activeStreamId`) so future feature parity is a port, not a
// rewrite. Phase 4 extends with per-stream subagent/process/todos/plan/
// process-output fields plus the per-stream bypass-state badges the
// StatusBar consumes.

import { signal, type Signal } from '@lit-labs/signals';

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type {
  ActiveChildInfo,
  ConversationProgress,
  NormalizedToolUse,
  Plan,
  StreamStatus,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';

export interface ConversationEntry {
  /** Same id as the upstream `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  readonly role: 'assistant' | 'error' | 'process' | 'tool' | 'user';
  /** Concatenated text for `MODEL_RESPONSE` entries. Empty for tool rows. */
  readonly text: string;
  /** True once the stream transitions to `WAITING`/`COMPLETED`. */
  readonly finalized: boolean;
  /** Populated only when `role === 'tool'`. */
  readonly toolUse?: NormalizedToolUse;
  /** Populated only when `role === 'process'`. */
  readonly process?: CompletedProcessTranscript;
  /** Entry was synthesized by the CLI and is not present in StreamLogStore. */
  readonly synthetic?: boolean;
  /** Why the CLI synthesized this entry. */
  readonly syntheticKind?: 'final' | 'local' | 'process';
  /** StreamLog head at the moment a synthetic entry was appended. */
  readonly syntheticAfterSeq?: number;
}

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
  readonly cwd: string;
  readonly apiMode: CliApiMode;
  readonly canDelegate: boolean;
  readonly version: string;
}

export interface ProcessOutputTail {
  readonly stdout: string;
  readonly stderr: string;
}

export interface BypassState {
  readonly toolEdit: boolean;
  readonly superYolo: boolean;
}

export interface StreamSlice {
  readonly streamId: StreamTabId;
  readonly status: StreamStatus | undefined;
  readonly description: string | undefined;
  readonly usage: TokenUsageStats | undefined;
  readonly conversation: ConversationProgress | undefined;
  readonly entries: readonly ConversationEntry[];
  readonly queuedFollowUps: number;
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
  /** YOLO / BYPASS state is stream-scoped upstream (see
   *  `permissionSlice.ts` in the extension), so concurrent parent/child
   *  sessions can show distinct badges. */
  readonly bypass: BypassState;
}

const EMPTY_SESSION_META: SessionMeta = {
  agent: '',
  model: '',
  cwd: '',
  apiMode: 'personal',
  canDelegate: false,
  version: '',
};

const SESSION_META = signal<SessionMeta>(EMPTY_SESSION_META);

const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);

const STREAMS = signal<ReadonlyMap<StreamTabId, StreamSlice>>(new Map());

/** child -> parent map populated from `setParentStream`. The focus cycle
 *  (Ctrl-A / Ctrl-B) walks this when stepping back to the parent. */
const PARENT_STREAM = signal<ReadonlyMap<StreamTabId, StreamTabId>>(new Map());

/** Active inline slash form, or `undefined` when the chat input owns the
 *  screen. The form's `onDone` clears this slot. Kept opaque (the form
 *  carries its own state) so the registry stays declarative. */
export interface ActiveSlashForm {
  /** The slash command that mounted the form (for the header strip). */
  readonly commandName: string;
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

const PENDING_EXIT_HINT = signal<boolean>(false);
const PENDING_EXIT_RESUME_ID = signal<string | undefined>(undefined);

const RESET_HOOKS = new Set<() => void>();

export const cliState = {
  sessionMeta: SESSION_META as Signal.State<SessionMeta>,
  activeStreamId: ACTIVE_STREAM_ID as Signal.State<StreamTabId | undefined>,
  streams: STREAMS as Signal.State<ReadonlyMap<StreamTabId, StreamSlice>>,
  parentStream: PARENT_STREAM as Signal.State<
    ReadonlyMap<StreamTabId, StreamTabId>
  >,
  activeForm: ACTIVE_FORM as Signal.State<ActiveSlashForm | undefined>,
  slashPaletteOpen: SLASH_PALETTE_OPEN as Signal.State<boolean>,
  reverseSearchOpen: REVERSE_SEARCH_OPEN as Signal.State<boolean>,
  pendingExitHint: PENDING_EXIT_HINT as Signal.State<boolean>,
  pendingExitResumeId: PENDING_EXIT_RESUME_ID as Signal.State<
    string | undefined
  >,
};

export const NO_BYPASS: BypassState = { toolEdit: false, superYolo: false };

function emptySlice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    status: undefined,
    description: undefined,
    usage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
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

export function setParentStream(
  childStreamId: StreamTabId,
  parentStreamId: StreamTabId | null | undefined,
): void {
  const current = cliState.parentStream.get();
  // A null parent means the runtime promoted this child to a top-level stream.
  if (parentStreamId == null || childStreamId === parentStreamId) {
    if (!current.has(childStreamId)) return;
    const out = new Map(current);
    out.delete(childStreamId);
    cliState.parentStream.set(out);
    return;
  }
  if (current.get(childStreamId) === parentStreamId) return;
  const out = new Map(current);
  out.set(childStreamId, parentStreamId);
  cliState.parentStream.set(out);
}

export function removeStream(streamId: StreamTabId): void {
  const current = cliState.streams.get();
  if (!current.has(streamId)) return;
  const out = new Map(current);
  out.delete(streamId);
  cliState.streams.set(out);
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

function defaultSessionMeta(): SessionMeta {
  // Preserve the resolved CLI version across resets; everything else clears.
  return { ...EMPTY_SESSION_META, version: SESSION_META.get().version };
}

export function resetCliState(sessionMeta = defaultSessionMeta()): void {
  cliState.sessionMeta.set(sessionMeta);
  cliState.activeStreamId.set(undefined);
  cliState.streams.set(new Map());
  cliState.parentStream.set(new Map());
  cliState.activeForm.set(undefined);
  cliState.slashPaletteOpen.set(false);
  cliState.reverseSearchOpen.set(false);
  cliState.pendingExitHint.set(false);
  cliState.pendingExitResumeId.set(undefined);
  for (const resetHook of RESET_HOOKS) resetHook();
}

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

export function canShowSubagentControls(
  meta: Pick<SessionMeta, 'canDelegate'>,
  slice: Pick<StreamSlice, 'childStreams'> | undefined,
): boolean {
  return meta.canDelegate || (slice?.childStreams.length ?? 0) > 0;
}

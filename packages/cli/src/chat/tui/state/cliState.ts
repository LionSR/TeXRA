// Signal-backed state for the CLI TUI. Mirrors the webview's `progressState`
// shape — same primitives (`@lit-labs/signals`), same shape (one record per
// stream + an `activeStreamId`) so future feature parity is a port, not a
// rewrite. Phase 4 extends with per-stream subagent/process/todos/plan/
// process-output fields plus the per-stream bypass-state badges the
// StatusBar consumes.

import { signal, type Signal } from '@lit-labs/signals';

import type { NormalizedToolUse, StreamTabId } from '@shared/schemas';
import type {
  ActiveChildInfo,
  ConversationProgress,
  Plan,
  StreamStatus,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';

export interface ConversationEntry {
  /** Same id as the upstream `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  readonly role: 'assistant' | 'error' | 'tool' | 'user';
  /** Concatenated text for `MODEL_RESPONSE` entries. Empty for tool rows. */
  readonly text: string;
  /** True once the stream transitions to `WAITING`/`COMPLETED`. */
  readonly finalized: boolean;
  /** Populated only when `role === 'tool'`. */
  readonly toolUse?: NormalizedToolUse;
  /** Identity of the `StreamLogEntry.data` `toolUse` was derived from.
   *  Cache key for `renderLogEntry` — when the next sync sees the same
   *  ref it skips re-normalizing (Zod parse + YAML stringify on the
   *  streaming hot path). */
  readonly toolUseSource?: unknown;
  /** Entry was synthesized by the CLI and is not present in StreamLogStore. */
  readonly synthetic?: boolean;
  /** Why the CLI synthesized this entry. */
  readonly syntheticKind?: 'final' | 'local';
  /** StreamLog head at the moment a synthetic entry was appended. */
  readonly syntheticAfterSeq?: number;
}

export interface SessionMeta {
  readonly agent: string;
  readonly model: string;
  readonly cwd: string;
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
  readonly usage: TokenUsageStats | undefined;
  readonly conversation: ConversationProgress | undefined;
  readonly entries: readonly ConversationEntry[];
  readonly queuedFollowUps: number;
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly activeProcesses: readonly ActiveChildInfo[];
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

const SESSION_META = signal<SessionMeta>({
  agent: '',
  model: '',
  cwd: '',
});

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
  readonly render: (onDone: () => void) => React.ReactNode;
}
const ACTIVE_FORM = signal<ActiveSlashForm | undefined>(undefined);

/** True while the slash-command palette is mounted in the InputBar. App-level
 *  Tab handlers gate on this so palette-Tab (accept selection) doesn't double
 *  with stream-focus Tab. */
const SLASH_PALETTE_OPEN = signal<boolean>(false);

const PENDING_EXIT_HINT = signal<boolean>(false);

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
  pendingExitHint: PENDING_EXIT_HINT as Signal.State<boolean>,
};

export const NO_BYPASS: BypassState = { toolEdit: false, superYolo: false };

function emptySlice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    status: undefined,
    usage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
    activeSubagents: [],
    activeProcesses: [],
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
  parentStreamId: StreamTabId,
): void {
  const current = cliState.parentStream.get();
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

export function resetCliState(): void {
  cliState.sessionMeta.set({ agent: '', model: '', cwd: '' });
  cliState.activeStreamId.set(undefined);
  cliState.streams.set(new Map());
  cliState.parentStream.set(new Map());
  cliState.activeForm.set(undefined);
  cliState.slashPaletteOpen.set(false);
  cliState.pendingExitHint.set(false);
  for (const resetHook of RESET_HOOKS) resetHook();
}

export function registerCliStateResetHook(resetHook: () => void): void {
  RESET_HOOKS.add(resetHook);
}

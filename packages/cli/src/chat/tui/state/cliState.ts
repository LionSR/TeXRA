// Signal-backed state for the CLI TUI. Mirrors the webview's `progressState`
// shape — same primitives (`@lit-labs/signals`), same shape (one record per
// stream + an `activeStreamId`) so future feature parity is a port, not a
// rewrite. Phase 1 only exposes the fields the header + conversation pane +
// input bar actually consume; later phases extend.

import { signal, type Signal } from '@lit-labs/signals';

import type { StreamTabId } from '@shared/schemas';
import type {
  ConversationProgress,
  StreamStatus,
  TokenUsageStats,
} from '@shared/schemas';

export interface ConversationEntry {
  /** Same id as the upstream `StreamLogEntry.id` — stable across deltas. */
  readonly id: string;
  /** Concatenated text for `MODEL_RESPONSE` entries. */
  readonly text: string;
  /** True once the stream transitions to `WAITING`/`COMPLETED`. */
  readonly finalized: boolean;
}

export interface SessionMeta {
  readonly agent: string;
  readonly model: string;
  readonly cwd: string;
}

export interface StreamSlice {
  readonly streamId: StreamTabId;
  readonly status: StreamStatus | undefined;
  readonly description: string | undefined;
  readonly usage: TokenUsageStats | undefined;
  readonly conversation: ConversationProgress | undefined;
  readonly entries: readonly ConversationEntry[];
  readonly queuedFollowUps: number;
}

const SESSION_META = signal<SessionMeta>({
  agent: '',
  model: '',
  cwd: '',
});

const ACTIVE_STREAM_ID = signal<StreamTabId | undefined>(undefined);

const STREAMS = signal<ReadonlyMap<StreamTabId, StreamSlice>>(new Map());

export const cliState = {
  sessionMeta: SESSION_META as Signal.State<SessionMeta>,
  activeStreamId: ACTIVE_STREAM_ID as Signal.State<StreamTabId | undefined>,
  streams: STREAMS as Signal.State<ReadonlyMap<StreamTabId, StreamSlice>>,
};

function emptySlice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    status: undefined,
    description: undefined,
    usage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
  };
}

function withSliceUpdate(
  current: ReadonlyMap<StreamTabId, StreamSlice>,
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): ReadonlyMap<StreamTabId, StreamSlice> {
  const slice = current.get(streamId) ?? emptySlice(streamId);
  const next = update(slice);
  if (next === slice) return current;
  const out = new Map(current);
  out.set(streamId, next);
  return out;
}

export function patchStream(
  streamId: StreamTabId,
  update: (slice: StreamSlice) => StreamSlice,
): void {
  cliState.streams.set(
    withSliceUpdate(cliState.streams.get(), streamId, update),
  );
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
}

export function resetCliState(): void {
  cliState.sessionMeta.set({ agent: '', model: '', cwd: '' });
  cliState.activeStreamId.set(undefined);
  cliState.streams.set(new Map());
}

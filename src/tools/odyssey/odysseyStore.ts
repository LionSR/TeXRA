import { randomUUID } from 'crypto';

import {
  getWorkspaceState,
  tryGetWorkspaceState,
} from '@agent/core/stateStore';
import type { StreamTabId } from '@shared/schemas/identifiers';

import {
  ODYSSEY_HISTORY_LIMIT,
  OdysseySchema,
  type Odyssey,
  type OdysseyEvent,
  type OdysseyEventKind,
  type OdysseyStatus,
} from './odysseyMeta';

const STREAM_KEY_PREFIX = 'odysseys:byStream:';
const INDEX_KEY = 'odysseys:index';
// Stream index growth is user-driven (one entry per stream that ever had
// an Odyssey). `forget()` removes entries; callers that delete a stream
// without calling `forget()` leave dangling entries until next manual cleanup.

function streamKey(streamId: StreamTabId): string {
  return `${STREAM_KEY_PREFIX}${streamId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateOdysseyId(): string {
  return `ody_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function trimHistory(events: readonly OdysseyEvent[]): OdysseyEvent[] {
  return events.length <= ODYSSEY_HISTORY_LIMIT
    ? [...events]
    : events.slice(-ODYSSEY_HISTORY_LIMIT);
}

function readRaw(streamId: StreamTabId): Odyssey | null {
  // tryGetWorkspaceState — bootstrap-tolerant: read-only paths called before
  // initPlatform() (e.g. early-stream syncs in some tests) return null
  // rather than throwing. Write paths still use getWorkspaceState() which
  // does throw, surfacing the misuse.
  const state = tryGetWorkspaceState();
  if (!state) return null;
  const raw = state.get<unknown>(streamKey(streamId));
  if (!raw) return null;
  const parsed = OdysseySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function writeRaw(odyssey: Odyssey): Promise<void> {
  await getWorkspaceState().update(streamKey(odyssey.streamId), odyssey);
}

function readIndex(): StreamTabId[] {
  const state = tryGetWorkspaceState();
  if (!state) return [];
  const raw = state.get<unknown>(INDEX_KEY);
  return Array.isArray(raw)
    ? (raw.filter((v) => typeof v === 'string') as string[])
    : [];
}

async function addToIndex(streamId: StreamTabId): Promise<void> {
  const index = readIndex();
  if (index.includes(streamId)) return;
  await getWorkspaceState().update(INDEX_KEY, [...index, streamId]);
}

async function removeFromIndex(streamId: StreamTabId): Promise<void> {
  const index = readIndex();
  const next = index.filter((id) => id !== streamId);
  if (next.length === index.length) return;
  await getWorkspaceState().update(INDEX_KEY, next);
}

/**
 * Read-modify-write helper. Returns null if no record exists; otherwise
 * calls `mutate`, trims the history ring, persists, and returns the result.
 * Used by every mutation method to avoid the same boilerplate four times.
 */
async function update(
  streamId: StreamTabId,
  mutate: (odyssey: Odyssey) => Odyssey,
): Promise<Odyssey | null> {
  const odyssey = readRaw(streamId);
  if (!odyssey) return null;
  const next = mutate(odyssey);
  const final: Odyssey = {
    ...next,
    history: trimHistory(next.history),
    updatedAt: nowIso(),
  };
  await writeRaw(final);
  return final;
}

const STATUS_TO_EVENT_KIND: Record<OdysseyStatus, OdysseyEventKind> = {
  active: 'resumed',
  paused: 'paused',
  complete: 'completed',
  abandoned: 'abandoned',
};

/**
 * Allowed state-machine transitions. `complete` and `abandoned` are terminal
 * — the only way past them is `forget()` followed by a fresh `start()`.
 */
const ALLOWED_TRANSITIONS: Record<OdysseyStatus, readonly OdysseyStatus[]> = {
  active: ['paused', 'complete', 'abandoned'],
  paused: ['active', 'abandoned'],
  complete: [],
  abandoned: [],
};

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty or whitespace-only.`);
  }
  return trimmed;
}

export const OdysseyStore = {
  /** Get the odyssey for a stream, or null when none exists. */
  getForStream(streamId: StreamTabId): Odyssey | null {
    return readRaw(streamId);
  },

  /** Get all odysseys (for the OdysseyTab cross-conversation list). */
  list(): Odyssey[] {
    return readIndex()
      .map((id) => readRaw(id))
      .filter((o): o is Odyssey => o !== null);
  },

  /**
   * Create a new active odyssey for the stream. Throws if one already exists
   * in a non-terminal state (active or paused). Replaces complete/abandoned
   * records — finishing one and starting another is a normal flow.
   */
  async start(streamId: StreamTabId, objective: string): Promise<Odyssey> {
    const trimmed = requireNonEmpty(objective, 'objective');
    const existing = readRaw(streamId);
    if (
      existing &&
      (existing.status === 'active' || existing.status === 'paused')
    ) {
      throw new Error(
        `An odyssey is already in progress for this stream (status: ${existing.status}). ` +
          `Abandon or complete it before starting a new one.`,
      );
    }
    const now = nowIso();
    const odyssey: Odyssey = {
      odysseyId: generateOdysseyId(),
      streamId,
      objective: trimmed,
      status: 'active',
      tokensUsed: 0,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, kind: 'started', detail: trimmed }],
    };
    await writeRaw(odyssey);
    await addToIndex(streamId);
    return odyssey;
  },

  /**
   * Transition status; returns the updated record. No-op when status is
   * unchanged. Returns null when no record exists for the stream. Throws
   * when the transition is not in ALLOWED_TRANSITIONS — `complete` and
   * `abandoned` are terminal and cannot be re-entered without `forget()`.
   */
  async setStatus(
    streamId: StreamTabId,
    nextStatus: OdysseyStatus,
    detail?: string,
  ): Promise<Odyssey | null> {
    const current = readRaw(streamId);
    if (!current) return null;
    if (current.status === nextStatus) return current;
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(
        `Illegal odyssey transition: ${current.status} → ${nextStatus}. ` +
          `Terminal statuses (complete, abandoned) require forget() before a new start().`,
      );
    }
    return update(streamId, (odyssey) => ({
      ...odyssey,
      status: nextStatus,
      completedReason:
        nextStatus === 'complete'
          ? (detail ?? odyssey.completedReason)
          : odyssey.completedReason,
      history: [
        ...odyssey.history,
        {
          at: nowIso(),
          kind: STATUS_TO_EVENT_KIND[nextStatus],
          detail: detail ?? null,
        },
      ],
    }));
  },

  /** Append an event to the history; no-op when no record exists. */
  async recordEvent(
    streamId: StreamTabId,
    kind: OdysseyEventKind,
    detail?: string,
  ): Promise<void> {
    await update(streamId, (odyssey) => ({
      ...odyssey,
      history: [
        ...odyssey.history,
        { at: nowIso(), kind, detail: detail ?? null },
      ],
    }));
  },

  /** Accumulate per-turn token usage (called from applyTurnAccounting). */
  async addUsage(streamId: StreamTabId, tokensDelta: number): Promise<void> {
    if (tokensDelta <= 0) return;
    await update(streamId, (odyssey) => ({
      ...odyssey,
      tokensUsed: odyssey.tokensUsed + Math.floor(tokensDelta),
    }));
  },

  /** Replace the objective. Used by the user-side edit-objective flow. */
  async editObjective(
    streamId: StreamTabId,
    newObjective: string,
  ): Promise<Odyssey> {
    const trimmed = requireNonEmpty(newObjective, 'objective');
    const updated = await update(streamId, (odyssey) => ({
      ...odyssey,
      objective: trimmed,
      history: [
        ...odyssey.history,
        { at: nowIso(), kind: 'objective_edited', detail: trimmed },
      ],
    }));
    if (!updated) {
      throw new Error('No odyssey found for this stream.');
    }
    return updated;
  },

  /** Drop the record (used on conversation delete). */
  async forget(streamId: StreamTabId): Promise<void> {
    await getWorkspaceState().update(streamKey(streamId), undefined);
    await removeFromIndex(streamId);
  },
};

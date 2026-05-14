import { getWorkspaceState } from '@agent/core/stateStore';
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

function streamKey(streamId: StreamTabId): string {
  return `${STREAM_KEY_PREFIX}${streamId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateOdysseyId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ody_${Date.now().toString(36)}_${rand}`;
}

function trimHistory(events: readonly OdysseyEvent[]): OdysseyEvent[] {
  return events.length <= ODYSSEY_HISTORY_LIMIT
    ? [...events]
    : events.slice(-ODYSSEY_HISTORY_LIMIT);
}

function readRaw(streamId: StreamTabId): Odyssey | null {
  const raw = getWorkspaceState().get<unknown>(streamKey(streamId));
  if (!raw) return null;
  const parsed = OdysseySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function writeRaw(odyssey: Odyssey): Promise<void> {
  await getWorkspaceState().update(streamKey(odyssey.streamId), odyssey);
}

async function readIndex(): Promise<StreamTabId[]> {
  const raw = getWorkspaceState().get<unknown>(INDEX_KEY);
  return Array.isArray(raw)
    ? (raw.filter((v) => typeof v === 'string') as string[])
    : [];
}

async function addToIndex(streamId: StreamTabId): Promise<void> {
  const index = await readIndex();
  if (index.includes(streamId)) return;
  await getWorkspaceState().update(INDEX_KEY, [...index, streamId]);
}

async function removeFromIndex(streamId: StreamTabId): Promise<void> {
  const index = await readIndex();
  const next = index.filter((id) => id !== streamId);
  if (next.length === index.length) return;
  await getWorkspaceState().update(INDEX_KEY, next);
}

export const OdysseyStore = {
  /** Get the odyssey for a stream, or null when none exists. */
  getForStream(streamId: StreamTabId): Odyssey | null {
    return readRaw(streamId);
  },

  /** Get all odysseys (for the OdysseyTab cross-conversation list). */
  async list(): Promise<Odyssey[]> {
    const ids = await readIndex();
    const records: Odyssey[] = [];
    for (const id of ids) {
      const odyssey = readRaw(id);
      if (odyssey) records.push(odyssey);
    }
    return records;
  },

  /**
   * Create a new active odyssey for the stream. Throws if one already exists
   * in a non-terminal state (active or paused). Replaces complete/abandoned
   * records — finishing one and starting another is a normal flow.
   */
  async start(streamId: StreamTabId, objective: string): Promise<Odyssey> {
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
      objective: objective.trim(),
      status: 'active',
      tokensUsed: 0,
      timeUsedMs: 0,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, kind: 'started', detail: objective.trim() }],
    };
    await writeRaw(odyssey);
    await addToIndex(streamId);
    return odyssey;
  },

  /** Transition status; returns the updated record. Throws on illegal transition. */
  async setStatus(
    streamId: StreamTabId,
    nextStatus: OdysseyStatus,
    detail?: string,
  ): Promise<Odyssey> {
    const odyssey = readRaw(streamId);
    if (!odyssey) {
      throw new Error('No odyssey found for this stream.');
    }
    if (odyssey.status === nextStatus) return odyssey;

    const eventKindMap: Record<OdysseyStatus, OdysseyEventKind> = {
      active: 'resumed',
      paused: 'paused',
      complete: 'completed',
      abandoned: 'abandoned',
    };
    const now = nowIso();
    const updated: Odyssey = {
      ...odyssey,
      status: nextStatus,
      updatedAt: now,
      completedReason:
        nextStatus === 'complete'
          ? (detail ?? odyssey.completedReason)
          : odyssey.completedReason,
      history: trimHistory([
        ...odyssey.history,
        { at: now, kind: eventKindMap[nextStatus], detail: detail ?? null },
      ]),
    };
    await writeRaw(updated);
    return updated;
  },

  /** Append an event to the history. Idempotent at the call site only. */
  async recordEvent(
    streamId: StreamTabId,
    kind: OdysseyEventKind,
    detail?: string,
  ): Promise<void> {
    const odyssey = readRaw(streamId);
    if (!odyssey) return;
    const now = nowIso();
    const updated: Odyssey = {
      ...odyssey,
      updatedAt: now,
      history: trimHistory([
        ...odyssey.history,
        { at: now, kind, detail: detail ?? null },
      ]),
    };
    await writeRaw(updated);
  },

  /** Accumulate per-turn accounting numbers (called from applyTurnAccounting). */
  async addUsage(
    streamId: StreamTabId,
    tokensDelta: number,
    timeDeltaMs: number,
  ): Promise<void> {
    const odyssey = readRaw(streamId);
    if (!odyssey) return;
    const updated: Odyssey = {
      ...odyssey,
      tokensUsed: odyssey.tokensUsed + Math.max(0, Math.floor(tokensDelta)),
      timeUsedMs: odyssey.timeUsedMs + Math.max(0, Math.floor(timeDeltaMs)),
      updatedAt: nowIso(),
    };
    await writeRaw(updated);
  },

  /** Replace the objective. Used by the user-side edit-objective flow. */
  async editObjective(
    streamId: StreamTabId,
    newObjective: string,
  ): Promise<Odyssey> {
    const odyssey = readRaw(streamId);
    if (!odyssey) {
      throw new Error('No odyssey found for this stream.');
    }
    const now = nowIso();
    const updated: Odyssey = {
      ...odyssey,
      objective: newObjective.trim(),
      updatedAt: now,
      history: trimHistory([
        ...odyssey.history,
        { at: now, kind: 'objective_edited', detail: newObjective.trim() },
      ]),
    };
    await writeRaw(updated);
    return updated;
  },

  /** Drop the record (used on conversation delete). */
  async forget(streamId: StreamTabId): Promise<void> {
    await getWorkspaceState().update(streamKey(streamId), undefined);
    await removeFromIndex(streamId);
  },
};

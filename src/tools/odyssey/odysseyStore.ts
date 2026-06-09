import { randomUUID } from 'crypto';

import { platform } from '@platform/platform';
import { tryGetWorkspaceState } from '@agent/core/stateStore';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas/identifiers';

import type { Plan } from '@shared/schemas/plan';

import { filterNotNull } from '@utils/core';
import {
  OdysseySchema,
  isOdysseyInFlight,
  type Odyssey,
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

function readRaw(streamId: StreamTabId): Odyssey | null {
  // tryGetWorkspaceState — bootstrap-tolerant: read-only paths called before
  // initPlatform() (e.g. early-stream syncs in some tests) return null
  // rather than throwing. Write paths still use platform().workspaceState which
  // does throw, surfacing the misuse.
  const state = tryGetWorkspaceState();
  if (!state) return null;
  const raw = state.get<unknown>(streamKey(streamId));
  if (!raw) return null;
  const parsed = OdysseySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function writeRaw(odyssey: Odyssey): Promise<void> {
  await platform().workspaceState.update(streamKey(odyssey.streamId), odyssey);
}

function readIndex(): StreamTabId[] {
  const state = tryGetWorkspaceState();
  if (!state) return [];
  const raw = state.get<unknown>(INDEX_KEY);
  return Array.isArray(raw)
    ? raw.filter((v): v is StreamTabId => typeof v === 'string')
    : [];
}

async function addToIndex(streamId: StreamTabId): Promise<void> {
  const index = readIndex();
  if (index.includes(streamId)) return;
  await platform().workspaceState.update(INDEX_KEY, [...index, streamId]);
}

async function removeFromIndex(streamId: StreamTabId): Promise<void> {
  const index = readIndex();
  const next = index.filter((id) => id !== streamId);
  if (next.length === index.length) return;
  await platform().workspaceState.update(INDEX_KEY, next);
}

/**
 * Read-modify-write helper. Returns null if no record exists; otherwise
 * calls `mutate`, persists, broadcasts, and returns the result.
 */
async function update(
  streamId: StreamTabId,
  mutate: (odyssey: Odyssey) => Odyssey,
): Promise<Odyssey | null> {
  const odyssey = readRaw(streamId);
  if (!odyssey) return null;
  const final: Odyssey = { ...mutate(odyssey), updatedAt: nowIso() };
  await writeRaw(final);
  bus.emit('odysseyStateChanged', { streamId });
  return final;
}

/**
 * Allowed state-machine transitions. Both live states are reachable from each
 * other (resume a paused pursuit; pause an active one). Finishing or abandoning
 * an odyssey is `forget()`, not a status — there are no terminal states.
 */
const ALLOWED_TRANSITIONS: Record<OdysseyStatus, readonly OdysseyStatus[]> = {
  active: ['paused'],
  paused: ['active'],
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
      .filter(filterNotNull);
  },

  /**
   * Create a new active odyssey for the stream. Throws if one already exists
   * (active or paused). Finishing one (forget) and starting another is normal.
   */
  async start(
    streamId: StreamTabId,
    objective: string,
    options?: { plan?: Plan },
  ): Promise<Odyssey> {
    const trimmed = requireNonEmpty(objective, 'objective');
    const existing = readRaw(streamId);
    if (existing && isOdysseyInFlight(existing)) {
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
      createdAt: now,
      updatedAt: now,
      plan: options?.plan ?? null,
    };
    await Promise.all([writeRaw(odyssey), addToIndex(streamId)]);
    bus.emit('odysseyStateChanged', { streamId });
    return odyssey;
  },

  /**
   * Transition status; returns the updated record. No-op when status is
   * unchanged. Returns null when no record exists. Throws when the transition
   * is not in ALLOWED_TRANSITIONS (only active<->paused are legal; finishing
   * is `forget()`).
   */
  async setStatus(
    streamId: StreamTabId,
    nextStatus: OdysseyStatus,
  ): Promise<Odyssey | null> {
    const current = readRaw(streamId);
    if (!current) return null;
    if (current.status === nextStatus) return current;
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(
        `Illegal odyssey transition: ${current.status} → ${nextStatus}.`,
      );
    }
    return update(streamId, (odyssey) => ({ ...odyssey, status: nextStatus }));
  },

  /**
   * Replace the objective (and optionally the originating plan).
   * Used by the Approve & Run path when an odyssey is already in flight —
   * re-targeting an active loop is preferable to silently leaving it
   * pointed at a stale objective.
   */
  async editObjective(
    streamId: StreamTabId,
    newObjective: string,
    options?: { plan?: Plan | null },
  ): Promise<Odyssey> {
    const trimmed = requireNonEmpty(newObjective, 'objective');
    // `options.plan !== undefined` keeps absent and explicit `undefined` both
    // as "don't touch plan"; `null` still means "clear".
    const planUpdate =
      options?.plan !== undefined ? { plan: options.plan } : {};
    const updated = await update(streamId, (odyssey) => ({
      ...odyssey,
      objective: trimmed,
      ...planUpdate,
    }));
    if (!updated) {
      throw new Error('No odyssey found for this stream.');
    }
    return updated;
  },

  /** Drop the record (used on complete, abandon, or conversation delete).
   *  Bootstrap-tolerant — cleanup paths shouldn't fail loudly if state isn't
   *  wired yet. */
  async forget(streamId: StreamTabId): Promise<void> {
    const state = tryGetWorkspaceState();
    if (!state) return;
    const existed = readRaw(streamId) !== null;
    if (!existed) return;
    await Promise.all([
      state.update(streamKey(streamId), undefined),
      removeFromIndex(streamId),
    ]);
    bus.emit('odysseyStateChanged', { streamId });
  },

  /**
   * Bulk variant for callers that need to forget many streams at once
   * (e.g. delete-all-streams). Per-stream record deletes run in parallel
   * — independent keys — but the index update is a single read-filter-
   * write so concurrent `forget()` calls don't race on it.
   */
  async forgetMany(streamIds: readonly StreamTabId[]): Promise<void> {
    const state = tryGetWorkspaceState();
    if (!state) return;
    const toRemove = streamIds.filter((id) => readRaw(id) !== null);
    if (toRemove.length === 0) return;
    const index = readIndex();
    const dropped = new Set(toRemove);
    const nextIndex = index.filter((id) => !dropped.has(id));
    await Promise.all([
      ...toRemove.map((id) => state.update(streamKey(id), undefined)),
      nextIndex.length === index.length
        ? Promise.resolve()
        : state.update(INDEX_KEY, nextIndex),
    ]);
    for (const id of toRemove)
      bus.emit('odysseyStateChanged', { streamId: id });
  },
};

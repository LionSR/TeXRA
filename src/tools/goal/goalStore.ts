import { z } from 'zod';
import { Mutex } from 'async-mutex';

import { platform, tryWorkspaceState } from '@platform/platform';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  type ExecutionId,
  StreamTabIdSchema,
  type StreamTabId,
} from '@shared/schemas/identifiers';
import {
  GoalSchema,
  isGoalInFlight,
  type Goal,
  type GoalStatus,
} from '@shared/schemas/goal';
import { filterNotNull, unique } from '@utils/core';
import { hexId12 } from '@utils/core/executionId';

const STREAM_KEY_PREFIX = 'goals:byStream:';
const INDEX_KEY = 'goals:index';
// Pre-rename keys (the feature was "Odyssey" before June 2026). Records written
// by an older build live under these; we read them as a fallback and migrate
// lazily — `writeRaw` always writes the new key, so any touched record moves
// over, and `forget` clears both so a stale legacy record can't reappear.
const LEGACY_STREAM_KEY_PREFIX = 'odysseys:byStream:';
const LEGACY_INDEX_KEY = 'odysseys:index';
// Stream index growth is user-driven (one entry per stream that ever had
// a Goal). `forget()` removes entries; callers that delete a stream
// without calling `forget()` leave dangling entries until next manual cleanup.
const indexMutex = new Mutex();

export interface GoalStateChange {
  readonly streamId: StreamTabId;
}

export type GoalStateChangeListener = (change: GoalStateChange) => void;

function streamKey(streamId: StreamTabId): string {
  return `${STREAM_KEY_PREFIX}${streamId}`;
}

function legacyStreamKey(streamId: StreamTabId): string {
  return `${LEGACY_STREAM_KEY_PREFIX}${streamId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateGoalId(): string {
  return `goal_${hexId12()}`;
}

const LegacyOdysseySchema = z.object({
  odysseyId: z.string().min(1),
  streamId: StreamTabIdSchema,
  objective: z.string().min(1),
  status: z.enum(['active', 'paused', 'complete', 'abandoned']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function normalizeGoalRecord(raw: unknown): Goal | null {
  const parsedGoal = GoalSchema.safeParse(raw);
  if (parsedGoal.success) return parsedGoal.data;

  const parsedLegacy = LegacyOdysseySchema.safeParse(raw);
  if (!parsedLegacy.success) return null;
  const legacy = parsedLegacy.data;
  if (legacy.status === 'complete' || legacy.status === 'abandoned') {
    return null;
  }
  return {
    goalId: legacy.odysseyId,
    streamId: legacy.streamId,
    objective: legacy.objective,
    status: legacy.status,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
}

function readRaw(streamId: StreamTabId): Goal | null {
  // tryWorkspaceState — bootstrap-tolerant: read-only paths called before
  // initPlatform() (e.g. early-stream syncs in some tests) return null
  // rather than throwing. Write paths still use platform().workspaceState which
  // does throw, surfacing the misuse.
  const state = tryWorkspaceState();
  if (!state) return null;
  // Prefer the current key; fall back to the pre-rename "odyssey" key.
  const current = normalizeGoalRecord(state.get<unknown>(streamKey(streamId)));
  if (current) return current;
  return normalizeGoalRecord(state.get<unknown>(legacyStreamKey(streamId)));
}

async function writeRaw(goal: Goal): Promise<void> {
  await platform().workspaceState.update(streamKey(goal.streamId), goal);
}

function parseIndex(raw: unknown): StreamTabId[] {
  return Array.isArray(raw)
    ? raw.filter((v): v is StreamTabId => typeof v === 'string')
    : [];
}

function readIndex(): StreamTabId[] {
  const state = tryWorkspaceState();
  if (!state) return [];
  // Union of the current and pre-rename indexes. `readRaw` filters out any
  // dangling entry whose record no longer exists under either key.
  const current = parseIndex(state.get<unknown>(INDEX_KEY));
  const legacy = parseIndex(state.get<unknown>(LEGACY_INDEX_KEY));
  return unique([...current, ...legacy]);
}

async function addToIndex(streamId: StreamTabId): Promise<void> {
  await mutateIndex((index) =>
    index.includes(streamId) ? index : [...index, streamId],
  );
}

/**
 * Rewrite INDEX_KEY from the unioned index and drop LEGACY_INDEX_KEY when
 * present, so a removed entry can't resurface from `odysseys:index` on the next
 * `readIndex`. Returns an empty list when nothing needs to change.
 */
function buildIndexWriteOps(
  state: NonNullable<ReturnType<typeof tryWorkspaceState>>,
  index: StreamTabId[],
  nextIndex: StreamTabId[],
  hasLegacyIndex: boolean,
): PromiseLike<void>[] {
  const ops: PromiseLike<void>[] = [];
  if (hasLegacyIndex || nextIndex.length !== index.length) {
    ops.push(state.update(INDEX_KEY, nextIndex));
  }
  if (hasLegacyIndex) {
    ops.push(state.update(LEGACY_INDEX_KEY, undefined));
  }
  return ops;
}

async function removeFromIndex(streamId: StreamTabId): Promise<void> {
  await mutateIndex((index) => index.filter((id) => id !== streamId));
}

async function mutateIndex(
  mutate: (index: StreamTabId[]) => StreamTabId[],
): Promise<void> {
  await indexMutex.runExclusive(async () => {
    const state = tryWorkspaceState();
    if (!state) return;
    const hasLegacyIndex = state.get<unknown>(LEGACY_INDEX_KEY) != null;
    const index = readIndex();
    const next = mutate(index);
    await Promise.all(buildIndexWriteOps(state, index, next, hasLegacyIndex));
  });
}

/**
 * Read-modify-write helper. Returns null if no record exists; otherwise
 * calls `mutate`, persists, broadcasts, and returns the result.
 */
async function update(
  streamId: StreamTabId,
  mutate: (goal: Goal) => Goal,
  // Callers that already read the record (setStatus) pass it in to skip a
  // second read-and-parse of the same workspaceState key.
  existing?: Goal,
): Promise<Goal | null> {
  const goal = existing ?? readRaw(streamId);
  if (!goal) return null;
  const final: Goal = { ...mutate(goal), updatedAt: nowIso() };
  await writeRaw(final);
  // In-run: the active run's session (ALS), falling back to the default session.
  emitRuntimeEvent('goalStateChanged', { streamId });
  return final;
}

/**
 * Allowed state-machine transitions. Both live states are reachable from each
 * other (resume a paused pursuit; pause an active one). Finishing or abandoning
 * a goal is `forget()`, not a status — there are no terminal states.
 */
const ALLOWED_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
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

/**
 * Subscribe to goal mutations in one explicitly-owned session.
 * Goal state is session-scoped: consumers must pass the session they render,
 * rather than listening on a process-wide compatibility event.
 */
export function subscribeGoalStateChanges(
  session: Pick<SessionHandle, 'events'>,
  listener: GoalStateChangeListener,
): () => void {
  return session.events.subscribe(
    (sessionEvent) => {
      if (
        sessionEvent.scope === 'session' &&
        sessionEvent.event.type === 'goalStateChanged'
      ) {
        listener(sessionEvent.event.payload);
      }
    },
    { scope: 'session' },
  );
}

export const GoalStore = {
  /** Get the goal for a stream, or null when none exists. */
  getForStream(streamId: StreamTabId): Goal | null {
    return readRaw(streamId);
  },

  /** Get all goals (for the GoalTab cross-conversation list). */
  list(): Goal[] {
    return readIndex()
      .map((id) => readRaw(id))
      .filter(filterNotNull);
  },

  /**
   * Create a new active goal for the stream. Throws if one already exists
   * (active or paused). Finishing one (forget) and starting another is normal.
   */
  async start(streamId: StreamTabId, objective: string): Promise<Goal> {
    const trimmed = requireNonEmpty(objective, 'objective');
    const existing = readRaw(streamId);
    if (existing && isGoalInFlight(existing)) {
      throw new Error(
        `A goal is already in progress for this stream (status: ${existing.status}). ` +
          `Abandon or complete it before starting a new one.`,
      );
    }
    const now = nowIso();
    const goal: Goal = {
      goalId: generateGoalId(),
      streamId,
      objective: trimmed,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([writeRaw(goal), addToIndex(streamId)]);
    emitRuntimeEvent('goalStateChanged', { streamId });
    return goal;
  },

  /**
   * Transition status; returns the updated record. No-op when status is
   * unchanged. Returns null when no record exists. Throws when the transition
   * is not in ALLOWED_TRANSITIONS (only active<->paused are legal; finishing
   * is `forget()`).
   */
  async setStatus(
    streamId: StreamTabId,
    nextStatus: GoalStatus,
  ): Promise<Goal | null> {
    const current = readRaw(streamId);
    if (!current) return null;
    if (current.status === nextStatus) return current;
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(
        `Illegal goal transition: ${current.status} → ${nextStatus}.`,
      );
    }
    return update(
      streamId,
      (goal) => ({ ...goal, status: nextStatus }),
      current,
    );
  },

  /**
   * Replace the objective. Used by the Approve & Run path when a goal is
   * already in flight — re-targeting an active loop is preferable to
   * silently leaving it pointed at a stale objective.
   */
  async editObjective(
    streamId: StreamTabId,
    newObjective: string,
  ): Promise<Goal> {
    const trimmed = requireNonEmpty(newObjective, 'objective');
    const updated = await update(streamId, (goal) => ({
      ...goal,
      objective: trimmed,
    }));
    if (!updated) {
      throw new Error('No goal found for this stream.');
    }
    return updated;
  },

  /** Drop the record (used on complete, abandon, or conversation delete).
   *  Bootstrap-tolerant — cleanup paths shouldn't fail loudly if state isn't
   *  wired yet. */
  async forget(streamId: StreamTabId, session?: SessionHandle): Promise<void> {
    const state = tryWorkspaceState();
    if (!state) return;
    // Gate on raw key presence, not parse success — an unparseable or
    // terminal-status legacy blob (which `readRaw` normalizes to null) must
    // still be cleaned up, or its key lingers forever.
    const existed =
      state.get<unknown>(streamKey(streamId)) != null ||
      state.get<unknown>(legacyStreamKey(streamId)) != null;
    if (!existed) return;
    await Promise.all([
      state.update(streamKey(streamId), undefined),
      // Clear the pre-rename key too, or a forgotten legacy record would
      // resurface via the readRaw fallback.
      state.update(legacyStreamKey(streamId), undefined),
      removeFromIndex(streamId),
    ]);
    // Dual-context: PlanTool forgets in-run (→ run session via ALS); hosts
    // pass their owning session for non-default windows.
    emitRuntimeEvent('goalStateChanged', { streamId }, session);
  },

  /**
   * Bulk variant for callers that need to forget many streams at once
   * (e.g. delete-all-streams). Per-stream record deletes run in parallel
   * — independent keys — but the index update is a single read-filter-
   * write so concurrent `forget()` calls don't race on it.
   */
  async forgetMany(
    streamIds: readonly StreamTabId[],
    session?: SessionHandle,
  ): Promise<void> {
    const state = tryWorkspaceState();
    if (!state) return;
    // Same raw-presence gate as `forget` so unparseable blobs are cleaned.
    const toRemove = streamIds.filter(
      (id) =>
        state.get<unknown>(streamKey(id)) != null ||
        state.get<unknown>(legacyStreamKey(id)) != null,
    );
    if (toRemove.length === 0) return;
    const dropped = new Set(toRemove);
    await Promise.all([
      ...toRemove.map((id) => state.update(streamKey(id), undefined)),
      ...toRemove.map((id) => state.update(legacyStreamKey(id), undefined)),
      mutateIndex((index) => index.filter((id) => !dropped.has(id))),
    ]);
    for (const id of toRemove)
      emitRuntimeEvent('goalStateChanged', { streamId: id }, session);
  },

  /**
   * Drop goals whose stream id belongs to one of the deleted executions.
   * GoalStore owns this suffix convention because it already owns the stream
   * index and legacy-key migration; callers should pass execution ids only.
   */
  async forgetByExecutionIds(
    executionIds: readonly ExecutionId[],
    session?: SessionHandle,
  ): Promise<void> {
    if (executionIds.length === 0) return;
    // Stream ids include the execution id as a final `#${executionId}` suffix.
    // ExecutionIdSchema permits only hex/dash characters, so `#` is a safe
    // delimiter rather than a character that can appear inside the id itself.
    const suffixes = unique(executionIds.map((id) => `#${id}`));
    const streamIds = readIndex().filter((streamId) =>
      suffixes.some((suffix) => streamId.endsWith(suffix)),
    );
    await GoalStore.forgetMany(streamIds, session);
  },
};

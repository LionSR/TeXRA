import { Mutex } from 'async-mutex';

import {
  resolveEmitSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { platform, tryWorkspaceState } from '@platform/platform';
import type {
  ExecutionId,
  Goal,
  GoalStatus,
  StreamTabId,
} from '@shared/schemas';
import { GoalSchema, isGoalInFlight } from '@shared/schemas';
import { filterNotNull, unique, hexId12 } from '@utils/core';

const STREAM_KEY_PREFIX = 'goals:byStream:';
const INDEX_KEY = 'goals:index';
// Stream index growth is user-driven (one entry per stream that ever had
// a Goal). `forget()` removes entries; callers that delete a stream
// without calling `forget()` leave dangling entries until next manual cleanup.
const indexMutex = new Mutex();

interface GoalStateChange {
  readonly streamId: StreamTabId;
}

type GoalStateChangeListener = (change: GoalStateChange) => void;

function streamKey(streamId: StreamTabId): string {
  return `${STREAM_KEY_PREFIX}${streamId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emitGoalStateChanged(
  streamId: StreamTabId,
  session?: SessionHandle,
): void {
  // Local storage commands can update goals without composing an agent
  // session. In that case there is no live observer to notify, so the shared
  // resolveEmitSession (non-throwing) returns undefined and we skip the emit.
  const target = resolveEmitSession(session);
  if (!target) return;
  target.events.emit({
    scope: 'session',
    event: {
      type: 'goalStateChanged',
      payload: { streamId },
    },
  });
}

function readRaw(streamId: StreamTabId): Goal | null {
  // tryWorkspaceState — bootstrap-tolerant: read-only paths called before
  // initPlatform() (e.g. early-stream syncs in some tests) return null
  // rather than throwing. Write paths still use platform().workspaceState which
  // does throw, surfacing the misuse.
  const state = tryWorkspaceState();
  if (!state) return null;
  const key = streamKey(streamId);
  const raw = state.get<unknown>(key);
  if (raw == null) return null;
  const parsed = GoalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Failed to parse persisted goal for stream "${streamId}" at storage key "${key}".`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function writeRaw(goal: Goal): Promise<void> {
  await platform().workspaceState.update(streamKey(goal.streamId), goal);
}

function readIndex(): StreamTabId[] {
  const state = tryWorkspaceState();
  if (!state) return [];
  const raw = state.get<unknown>(INDEX_KEY);
  const entries = Array.isArray(raw)
    ? raw.filter((v): v is StreamTabId => typeof v === 'string')
    : [];
  // Dedupe defensively — a corrupt or hand-edited workspaceState could
  // contain duplicate entries, which would otherwise surface as duplicate
  // goals in list() and cause redundant readRaw() calls.
  return unique(entries);
}

async function addToIndex(streamId: StreamTabId): Promise<void> {
  await mutateIndex((index) =>
    index.includes(streamId) ? index : [...index, streamId],
  );
}

/**
 * Mutate callbacks must return the same array reference (`index`, unchanged)
 * when nothing actually changed, so this can skip the write via reference
 * equality — all current callers (`addToIndex` and `forgetMany`'s inline
 * callback) already follow this contract.
 */
async function mutateIndex(
  mutate: (index: StreamTabId[]) => StreamTabId[],
): Promise<void> {
  await indexMutex.runExclusive(async () => {
    const state = tryWorkspaceState();
    if (!state) return;
    const index = readIndex();
    const next = mutate(index);
    if (next !== index) {
      await state.update(INDEX_KEY, next);
    }
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
  emitGoalStateChanged(streamId);
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

export const GoalStore = Object.freeze({
  /**
   * Get the goal for a stream, or null when none exists.
   *
   * @throws When a present saved record does not match {@link GoalSchema}.
   */
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
      goalId: `goal_${hexId12()}`,
      streamId,
      objective: trimmed,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([writeRaw(goal), addToIndex(streamId)]);
    emitGoalStateChanged(streamId);
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
   * Replace the objective. Used by the Run as Goal path when a goal is
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
    // Dual-context: PlanTool forgets in-run (→ run session via ALS); hosts
    // pass their owning session for non-default windows.
    await GoalStore.forgetMany([streamId], session);
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
    // Gate on raw key presence, not parse success, so explicit cleanup can
    // still remove an invalid record without first reading it.
    const toRemove = streamIds.filter(
      (id) => state.get<unknown>(streamKey(id)) != null,
    );
    if (toRemove.length === 0) return;
    const dropped = new Set(toRemove);
    await Promise.all([
      ...toRemove.map((id) => state.update(streamKey(id), undefined)),
      mutateIndex((index) => {
        const next = index.filter((id) => !dropped.has(id));
        return next.length === index.length ? index : next;
      }),
    ]);
    for (const id of toRemove) emitGoalStateChanged(id, session);
  },

  /**
   * Drop goals whose stream id belongs to one of the deleted executions.
   * GoalStore owns this suffix convention because it already owns the
   * stream index; callers should pass execution ids only.
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
});

import { randomUUID } from 'crypto';

import { platform } from '@platform/platform';
import { tryGetWorkspaceState } from '@agent/core/stateStore';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas/identifiers';

import type { Plan } from '@shared/schemas/plan';

import { filterNotNull } from '@utils/core';
import {
  GOAL_COST_CAP_CONFIG_KEY,
  GoalSchema,
  isGoalInFlight,
  type Goal,
  type GoalStatus,
} from './goalMeta';

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
  return `goal_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function readRaw(streamId: StreamTabId): Goal | null {
  // tryGetWorkspaceState — bootstrap-tolerant: read-only paths called before
  // initPlatform() (e.g. early-stream syncs in some tests) return null
  // rather than throwing. Write paths still use platform().workspaceState which
  // does throw, surfacing the misuse.
  const state = tryGetWorkspaceState();
  if (!state) return null;
  // Prefer the current key; fall back to the pre-rename "odyssey" key.
  const raw =
    state.get<unknown>(streamKey(streamId)) ??
    state.get<unknown>(legacyStreamKey(streamId));
  if (!raw) return null;
  const parsed = GoalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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
  const state = tryGetWorkspaceState();
  if (!state) return [];
  // Union of the current and pre-rename indexes. `readRaw` filters out any
  // dangling entry whose record no longer exists under either key.
  const current = parseIndex(state.get<unknown>(INDEX_KEY));
  const legacy = parseIndex(state.get<unknown>(LEGACY_INDEX_KEY));
  return [...new Set([...current, ...legacy])];
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
  mutate: (goal: Goal) => Goal,
): Promise<Goal | null> {
  const goal = readRaw(streamId);
  if (!goal) return null;
  const final: Goal = { ...mutate(goal), updatedAt: nowIso() };
  await writeRaw(final);
  bus.emit('goalStateChanged', { streamId });
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

/** Read the configured USD cost cap; `0`/unset/invalid mean unbounded (null). */
function configuredCostCapUsd(): number | null {
  const raw = platform().config.get<number>(GOAL_COST_CAP_CONFIG_KEY, 0);
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? raw
    : null;
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
  async start(
    streamId: StreamTabId,
    objective: string,
    options?: { plan?: Plan },
  ): Promise<Goal> {
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
      plan: options?.plan ?? null,
      costCapUsd: configuredCostCapUsd(),
      baselineRunCostUsd: null,
      spentUsd: 0,
    };
    await Promise.all([writeRaw(goal), addToIndex(streamId)]);
    bus.emit('goalStateChanged', { streamId });
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
    return update(streamId, (goal) => ({ ...goal, status: nextStatus }));
  },

  /**
   * Record the stream's current run cost against the goal and enforce the
   * cost cap. Called by the tool-use wait node before each continuation.
   *
   * The first observation becomes the baseline so conversation spend from
   * before the goal started doesn't count toward the cap. The run cost
   * already includes completed subagents (rolled up at the delegation
   * boundary), so subagents count toward the cap but never drive the loop.
   *
   * Returns `pausedForCap: true` only on the call that performs the
   * cap-pause, so callers can log the transition exactly once. No-op
   * (returns null) when the stream has no goal.
   */
  async noteRunCost(
    streamId: StreamTabId,
    runCostUsd: number,
  ): Promise<{ goal: Goal; pausedForCap: boolean } | null> {
    const current = readRaw(streamId);
    if (!current) return null;
    const baseline = current.baselineRunCostUsd ?? runCostUsd;
    const spentUsd = Math.max(0, runCostUsd - baseline);
    const capExceeded =
      current.costCapUsd != null && spentUsd >= current.costCapUsd;
    const pausedForCap = capExceeded && current.status === 'active';
    // Skip the write (and its broadcast) when nothing material changed.
    if (
      current.baselineRunCostUsd != null &&
      Math.abs(spentUsd - current.spentUsd) < 1e-9 &&
      !pausedForCap
    ) {
      return { goal: current, pausedForCap: false };
    }
    const goal = await update(streamId, (g) => ({
      ...g,
      baselineRunCostUsd: baseline,
      spentUsd,
      status: pausedForCap ? 'paused' : g.status,
    }));
    return goal ? { goal, pausedForCap } : null;
  },

  /**
   * Replace the objective (and optionally the originating plan).
   * Used by the Approve & Run path when a goal is already in flight —
   * re-targeting an active loop is preferable to silently leaving it
   * pointed at a stale objective.
   */
  async editObjective(
    streamId: StreamTabId,
    newObjective: string,
    options?: { plan?: Plan | null },
  ): Promise<Goal> {
    const trimmed = requireNonEmpty(newObjective, 'objective');
    // `options.plan !== undefined` keeps absent and explicit `undefined` both
    // as "don't touch plan"; `null` still means "clear".
    const planUpdate =
      options?.plan !== undefined ? { plan: options.plan } : {};
    const updated = await update(streamId, (goal) => ({
      ...goal,
      objective: trimmed,
      ...planUpdate,
    }));
    if (!updated) {
      throw new Error('No goal found for this stream.');
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
      // Clear the pre-rename key too, or a forgotten legacy record would
      // resurface via the readRaw fallback.
      state.update(legacyStreamKey(streamId), undefined),
      removeFromIndex(streamId),
    ]);
    bus.emit('goalStateChanged', { streamId });
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
      ...toRemove.map((id) => state.update(legacyStreamKey(id), undefined)),
      nextIndex.length === index.length
        ? Promise.resolve()
        : state.update(INDEX_KEY, nextIndex),
    ]);
    for (const id of toRemove) bus.emit('goalStateChanged', { streamId: id });
  },
};

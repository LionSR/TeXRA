import { Stream } from 'effect';

import {
  getRunContextSession,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { tryWorkspaceRoots, workspaceRoots } from '@platform/workspaceRoots';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  GoalSchema,
  isGoalInFlight,
  type Goal,
  type GoalState,
  type GoalStatus,
  type RunId,
  type AggregateTarget,
} from '@shared/schemas';
import { filterNotNull, unique, hexId12, KeyedMutex } from '@utils/core';

const RUN_KEY_PREFIX = 'goals:byRun:';
const INDEX_KEY = 'goals:index';
// Index growth is user-driven (one entry per run that ever had a Goal).
// `forget()` removes entries; callers that delete a run without calling
// `forget()` leave dangling entries until next manual cleanup.
// Single logical resource (the index), so KeyedMutex (utils/core/keyedMutex.ts)
// is used with one constant key rather than a bare Mutex — the same
// primitive most other module-level locks in the codebase already use.
const indexMutex = new KeyedMutex<'index'>();

/** One goal mutation as observed on a session's event plane. */
export interface GoalStateChange {
  readonly runId: RunId;
}

function runKey(runId: RunId): string {
  return `${RUN_KEY_PREFIX}${runId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The fact's snapshot (PRD 6, item 7): the goal after the mutation. */
function goalStateOf(goal: Goal | null): GoalState {
  return goal && isGoalInFlight(goal)
    ? { active: true, status: goal.status, objective: goal.objective }
    : { active: false };
}

// Callers already hold the goal they just wrote (or, for a delete, know it's
// now absent) — passing it in place of a fresh readRaw() avoids a redundant
// storage round trip and a narrow re-read race against a concurrent writer.
function emitGoalStateChanged(
  runId: RunId,
  current: Goal | null,
  session?: SessionHandle,
): void {
  // Local storage commands can update goals without composing an agent
  // session. In that case there is no live observer to notify, so the
  // non-throwing default resolution returns undefined and we skip the emit.
  const target =
    session ?? getRunContextSession(tryUseRunContext()) ?? tryDefaultSession();
  if (!target) return;
  target.publish([
    {
      type: 'goalStateChanged',
      aggregateId: qualifyAggregateId('run', runId),
      state: goalStateOf(current),
    },
  ]);
}

function readRaw(runId: RunId): Goal | null {
  // tryWorkspaceRoots is bootstrap-tolerant: read-only paths called before
  // the roots are installed (e.g. early-run syncs in some tests) return
  // null rather than throwing. Write paths still use workspaceRoots() which
  // does throw, surfacing the misuse.
  const state = tryWorkspaceRoots()?.workspaceState;
  if (!state) return null;
  const key = runKey(runId);
  const raw = state.get<unknown>(key);
  if (raw == null) return null;
  const parsed = GoalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Failed to parse persisted goal for run "${runId}" at storage key "${key}".`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function writeRaw(goal: Goal): Promise<void> {
  await workspaceRoots().workspaceState.update(runKey(goal.runId), goal);
}

function readIndex(): RunId[] {
  const state = tryWorkspaceRoots()?.workspaceState;
  if (!state) return [];
  const raw = state.get<unknown>(INDEX_KEY);
  const entries = Array.isArray(raw)
    ? raw.filter((v): v is RunId => typeof v === 'string')
    : [];
  // Dedupe defensively — a corrupt or hand-edited workspaceState could
  // contain duplicate entries, which would otherwise surface as duplicate
  // goals in list() and cause redundant readRaw() calls.
  return unique(entries);
}

async function addToIndex(runId: RunId): Promise<void> {
  await mutateIndex((index) =>
    index.includes(runId) ? index : [...index, runId],
  );
}

/**
 * Mutate callbacks must return the same array reference (`index`, unchanged)
 * when nothing actually changed, so this can skip the write via reference
 * equality — all current callers (`addToIndex` and `removeRecords`' inline
 * callback) already follow this contract.
 */
async function mutateIndex(mutate: (index: RunId[]) => RunId[]): Promise<void> {
  await indexMutex.runExclusive('index', async () => {
    const state = workspaceRoots().workspaceState;
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
  runId: RunId,
  mutate: (goal: Goal) => Goal,
  // Callers that already read the record (setStatus) pass it in to skip a
  // second read-and-parse of the same workspaceState key.
  existing?: Goal,
): Promise<Goal | null> {
  const goal = existing ?? readRaw(runId);
  if (!goal) return null;
  const final: Goal = { ...mutate(goal), updatedAt: nowIso() };
  await writeRaw(final);
  // In-run: the active run's session (ALS), falling back to the default session.
  emitGoalStateChanged(runId, final);
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
 * Goal mutations in one explicitly-owned session, from now on. Goal state is
 * session-scoped: consumers must pass the session they render, rather than
 * listening on a process-wide compatibility event. The stream is the whole
 * surface — the subscriber's host forks it at its own R1 boundary and
 * interrupts that fork when the view it renders closes, so this module owns
 * no fiber and no runtime.
 */
export function goalStateChanges(
  session: Pick<SessionHandle, 'folded' | 'now'>,
): Stream.Stream<GoalStateChange> {
  return session.folded(session.now()).pipe(
    Stream.filter(
      (event) =>
        event.type === 'goalStateChanged' || event.type === 'run.removed',
    ),
    Stream.map((event) => aggregateTarget(event.aggregateId)),
    Stream.filter(
      (target): target is Extract<AggregateTarget, { kind: 'run' }> =>
        target.kind === 'run',
    ),
    Stream.map((target) => ({ runId: target.id })),
  );
}

export const GoalStore = Object.freeze({
  /**
   * Get the goal for a run, or null when none exists.
   *
   * @throws When a present saved record does not match {@link GoalSchema}.
   */
  getForRun(runId: RunId): Goal | null {
    return readRaw(runId);
  },

  /** Get all goals (for the GoalTab cross-conversation list). */
  list(): Goal[] {
    return readIndex()
      .map((id) => readRaw(id))
      .filter(filterNotNull);
  },

  /**
   * Create a new active goal for the run. Throws if one already exists
   * (active or paused). Finishing one (forget) and starting another is normal.
   */
  async start(runId: RunId, objective: string): Promise<Goal> {
    const trimmed = requireNonEmpty(objective, 'objective');
    const existing = readRaw(runId);
    if (existing && isGoalInFlight(existing)) {
      throw new Error(
        `A goal is already in progress for this run (status: ${existing.status}). ` +
          `Abandon or complete it before starting a new one.`,
      );
    }
    const now = nowIso();
    const goal: Goal = {
      goalId: `goal_${hexId12()}`,
      runId,
      objective: trimmed,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([writeRaw(goal), addToIndex(runId)]);
    emitGoalStateChanged(runId, goal);
    return goal;
  },

  /**
   * Transition status; returns the updated record. No-op when status is
   * unchanged. Returns null when no record exists. Throws when the transition
   * is not in ALLOWED_TRANSITIONS (only active<->paused are legal; finishing
   * is `forget()`).
   */
  async setStatus(runId: RunId, nextStatus: GoalStatus): Promise<Goal | null> {
    const current = readRaw(runId);
    if (!current) return null;
    if (current.status === nextStatus) return current;
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(
        `Illegal goal transition: ${current.status} → ${nextStatus}.`,
      );
    }
    return update(runId, (goal) => ({ ...goal, status: nextStatus }), current);
  },

  /**
   * Replace the objective. Used by the Run as Goal path when a goal is
   * already in flight — re-targeting an active loop is preferable to
   * silently leaving it pointed at a stale objective.
   */
  async editObjective(runId: RunId, newObjective: string): Promise<Goal> {
    const trimmed = requireNonEmpty(newObjective, 'objective');
    const updated = await update(runId, (goal) => ({
      ...goal,
      objective: trimmed,
    }));
    if (!updated) {
      throw new Error('No goal found for this run.');
    }
    return updated;
  },

  /** Drop the record (used on complete, abandon, or conversation delete). */
  async forget(runId: RunId, session?: SessionHandle): Promise<void> {
    // Dual-context: PlanTool forgets in-run (→ run session via ALS); hosts
    // pass their owning session for non-default windows.
    await GoalStore.forgetMany([runId], session);
  },

  /**
   * Bulk variant for callers that need to forget many runs at once
   * (e.g. delete-all-runs). Per-run record deletes run in parallel
   * — independent keys — but the index update is a single read-filter-
   * write so concurrent `forget()` calls don't race on it.
   */
  async forgetMany(
    runIds: readonly RunId[],
    session?: SessionHandle,
  ): Promise<void> {
    const toRemove = await GoalStore.removeRecords(runIds);
    for (const id of toRemove) emitGoalStateChanged(id, null, session);
  },

  /** Remove stored records; the caller owns notification of the state change. */
  async removeRecords(runIds: readonly RunId[]): Promise<readonly RunId[]> {
    const state = workspaceRoots().workspaceState;
    // Gate on raw key presence, not parse success, so explicit cleanup can
    // still remove an invalid record without first reading it.
    const toRemove = runIds.filter(
      (id) => state.get<unknown>(runKey(id)) != null,
    );
    if (toRemove.length === 0) return [];
    const dropped = new Set(toRemove);
    await Promise.all([
      ...toRemove.map((id) => state.update(runKey(id), undefined)),
      mutateIndex((index) => {
        const next = index.filter((id) => !dropped.has(id));
        return next.length === index.length ? index : next;
      }),
    ]);
    return toRemove;
  },
});

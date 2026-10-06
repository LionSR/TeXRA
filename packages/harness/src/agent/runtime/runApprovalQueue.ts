/**
 * The session's requests: the approval prompt lanes, the run's approval
 * grants, and the {@link SessionRequests} value they are reached through.
 *
 * A run's grants have one owner, its `approval.policy` rows: a change is an
 * awaited commit of the run's next grants, read back from the rows, never a
 * value held here and published after. What a run's prompts bypass is read
 * from the session view on every check (`resolveBypass`), its own grants
 * first and then its ancestry's while the parent edge stands, so a toggle on
 * a parent reaches every descendant without a row of theirs.
 *
 * One value per session (#8144): two sessions queue and answer their
 * approvals independently. It is reached through the session itself
 * (`SessionHandle.requests`), never from context.
 */

import { Effect, SubscriptionRef } from 'effect';

import {
  APPROVAL_BYPASS_KINDS,
  inheritedGrants,
  NO_APPROVAL_GRANTS,
  resolveBypass,
  type ApprovalBypassKind,
  type ApprovalGrants,
  type ApprovalGrantSource,
} from '@shared/approvalBypassKind';
import {
  aggregateId,
  type CommitOrdinal,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  DeletionMode,
} from '@shared/session/database';
import type { RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { SessionView } from '@shared/session/sessionView';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

/**
 * One queued approval. `bypassed` exists because the queue can hold a request
 * behind another run prompt for arbitrarily long: if the user turns the
 * run's bypass on while this one waits (typically by answering the prompt
 * ahead of it with "approve and stop asking"), prompting anyway would ignore
 * the decision they just made.
 */
interface QueuedApproval<A, E, R> {
  /** Open the request and wait for its decision. */
  readonly prompt: Effect.Effect<A, E, R>;
  /** Result used instead when the run is bypassed by dispatch time. */
  readonly bypassed: Effect.Effect<A, E, R>;
}

/** The kinds whose prompts queue one at a time per run. */
type QueuedKind = Extract<ApprovalBypassKind, 'bash' | 'toolEdit'>;

/** A write of a run's grants refused: the store's own refusals. */
export type GrantWriteError =
  DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed;

/** The session doors the grants are read from and committed through. */
interface GrantStore {
  readonly view: SubscriptionRef.SubscriptionRef<SessionView>;
  readonly updateRecordFacts: <A, E>(
    runId: RunId,
    update: (
      rows: readonly SessionEvent[],
    ) => Effect.Effect<{ events: readonly SessionEventDraft[]; value: A }, E>,
  ) => Effect.Effect<A, E | GrantWriteError>;
  readonly readRunRecords: (
    runId: RunId,
  ) => Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
}

/** A run's grants as its rows record them: the latest `approval.policy`,
 *  else the snapshot its `run.start` carried. */
function recordedGrants(rows: readonly SessionEvent[]): ApprovalGrants {
  const latest = rows.findLast(
    (row) => row.type === 'approval.policy' || row.type === 'run.start',
  );
  if (latest?.type === 'approval.policy') return latest.snapshot;
  return latest?.type === 'run.start'
    ? (latest.approvalPolicy ?? NO_APPROVAL_GRANTS)
    : NO_APPROVAL_GRANTS;
}

/**
 * A run's grants once it activates again, or null when they stand as
 * recorded. A goal's grant does not outlive the activation that armed it:
 * the run's own goal ends, and a kind an ancestor's goal grants it is pinned
 * to the human value it inherits (off when none), since that goal is not
 * this activation's either.
 */
function afterActivation(
  source: ApprovalGrantSource<RunId>,
  runId: RunId,
  recorded: ApprovalGrants,
): ApprovalGrants | null {
  const inherited = inheritedGrants(source, runId).own;
  const pinned = APPROVAL_BYPASS_KINDS.filter(
    (kind) =>
      !recorded.goal.includes(kind) &&
      resolveBypass(source, runId, kind) === 'goal',
  );
  if (recorded.goal.length === 0 && pinned.length === 0) return null;
  const own = { ...recorded.own };
  for (const kind of pinned) own[kind] = inherited[kind] ?? 'off';
  return { own, goal: [] };
}

const sameGrants = (a: ApprovalGrants, b: ApprovalGrants): boolean =>
  JSON.stringify([a.own, [...a.goal].sort()]) ===
  JSON.stringify([b.own, [...b.goal].sort()]);

/**
 * The session's approvals: prompt lanes and the run's grants. Enforcement
 * reads {@link bypass}; every change goes through {@link change}.
 */
export interface SessionApprovals {
  /**
   * Serialize one prompt at a time per run and kind, re-reading the run's
   * bypass when the prompt reaches the head of its lane rather than at
   * enqueue.
   */
  enqueue<A, E, R>(
    kind: QueuedKind,
    runId: RunId | undefined,
    approval: QueuedApproval<A, E, R>,
  ): Effect.Effect<A, E, R>;
  /** Who bypasses one kind's prompts for a run, read from the view. */
  bypass(runId: RunId, kind: ApprovalBypassKind): 'goal' | 'human' | null;
  /**
   * Commit a run's next grants, `edit` applied to what its rows hold, and
   * return once they are durable and folded; an edit that changes nothing
   * writes nothing. Read and append are one job of the publisher, so two
   * changes of one run never lose each other's kind. The caller holds the
   * run's claim.
   */
  change(
    runId: RunId,
    edit: (grants: ApprovalGrants) => ApprovalGrants,
  ): Effect.Effect<void, GrantWriteError>;
  /**
   * The grants row a run's activation commits beside its `run.activate`, if
   * any (`afterActivation`), read from the rows of the run and its ancestry,
   * never from a view that may not have folded them yet.
   */
  activationRows(
    runId: RunId,
  ): Effect.Effect<readonly SessionEventDraft[], DatabaseReadFailed>;
}

/** Build the session's approvals over its view and its record door. */
export function createSessionApprovals(store: GrantStore): SessionApprovals {
  // One exclusive lane per kind and run: the queue a run's prompts take in
  // turn. `withPerKeyLane` owns the entries, so a lane leaves its map once
  // its last prompt settles.
  const lanes: Record<QueuedKind, Map<RunId | undefined, PerKeyLane>> = {
    bash: new Map(),
    toolEdit: new Map(),
  };
  const bypass: SessionApprovals['bypass'] = (runId, kind) =>
    resolveBypass(SubscriptionRef.getUnsafe(store.view), runId, kind);
  return {
    bypass,
    enqueue: (kind, runId, approval) =>
      Effect.suspend(() =>
        runId !== undefined && bypass(runId, kind) !== null
          ? approval.bypassed
          : approval.prompt,
      ).pipe(withPerKeyLane(lanes[kind], runId)),
    activationRows: (runId) =>
      Effect.gen(function* () {
        const runs = new Map<RunId, { parentId: RunId | null }>();
        const policy = new Map<RunId, ApprovalGrants>();
        for (let id: RunId | null = runId; id !== null && !runs.has(id);) {
          const rows: readonly SessionEvent[] = yield* store.readRunRecords(id);
          const start = rows.find(
            (row: SessionEvent) => row.type === 'run.start',
          );
          // A severed edge never comes back (`run.detach`).
          const parentId: RunId | null =
            start?.type === 'run.start' &&
            !rows.some((row: SessionEvent) => row.type === 'run.detach')
              ? (start.parent?.id ?? null)
              : null;
          runs.set(id, { parentId });
          policy.set(id, recordedGrants(rows));
          id = parentId;
        }
        const next = afterActivation(
          { runs, policy },
          runId,
          policy.get(runId) ?? NO_APPROVAL_GRANTS,
        );
        return next === null
          ? []
          : [
              {
                type: 'approval.policy' as const,
                aggregateId: aggregateId('run', runId),
                snapshot: next,
              },
            ];
      }),
    change: (runId, edit) => {
      // The claim holder's own grants are folded by the time each change
      // returns, so a change the view already shows writes nothing.
      const shown = SubscriptionRef.getUnsafe(store.view).policy.get(runId);
      if (shown !== undefined && sameGrants(shown, edit(shown)))
        return Effect.void;
      return store.updateRecordFacts(runId, (rows) => {
        const recorded = recordedGrants(rows);
        const next = edit(recorded);
        return Effect.succeed({
          events: sameGrants(recorded, next)
            ? []
            : [
                {
                  type: 'approval.policy' as const,
                  aggregateId: aggregateId('run', runId),
                  snapshot: next,
                },
              ],
          value: undefined,
        });
      });
    },
  };
}

/** A human's value for some kinds of one run: it supersedes the run's goal
 *  grant of those kinds. */
export const humanGrant =
  (kinds: readonly ApprovalBypassKind[], enabled: boolean) =>
  (grants: ApprovalGrants): ApprovalGrants => ({
    own: {
      ...grants.own,
      ...Object.fromEntries(
        kinds.map((kind) => [kind, enabled ? 'on' : 'off']),
      ),
    },
    goal: grants.goal.filter((kind) => !kinds.includes(kind)),
  });

/** Exactly the kinds a run's autonomous goal grants it; empty ends the
 *  grant, leaving what a human decided standing. */
export const goalGrant =
  (kinds: readonly ApprovalBypassKind[]) =>
  (grants: ApprovalGrants): ApprovalGrants => ({ ...grants, goal: kinds });

/**
 * Everything a surface asks of one session: its approvals and the one
 * handler every request goes through (PRD one-fold-three-renderers, 7.6 and
 * 8.2). Built by the session layer over that session's log and doors
 * (`SessionRequests.ts`); one value per session, so two sessions admit,
 * serialize and answer requests independently.
 */
export interface SessionRequests {
  /** This session's approval lanes and grants. */
  readonly approvals: SessionApprovals;
  /** Answer one request a surface issued: exactly once, an {@link Outcome}
   *  the host renders or a request error. */
  readonly request: (
    req: RuntimeRequest,
  ) => Effect.Effect<Outcome, RequestError>;
  /** Internal deletion policies share the same admission and transaction as
   *  a user's `run.delete`. */
  readonly removeRun: (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) => Effect.Effect<Outcome, RequestError>;
}

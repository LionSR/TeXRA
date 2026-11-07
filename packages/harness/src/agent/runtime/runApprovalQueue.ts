/**
 * The session's approvals: a run's grants, and how a request's session
 * write fails it.
 *
 * A run's grants have one owner, its `approval.policy` rows: a change is an
 * awaited commit of the run's next grants, read back from the rows, never a
 * value held here and published after. What a run's prompts bypass is read
 * from the session view on every check (`resolveBypass`), its own grants
 * first and then its ancestry's while the parent edge stands, so a toggle on
 * a parent reaches every descendant without a row of theirs. One value per
 * session, served as its `Approvals`.
 */
import { Effect, SubscriptionRef } from 'effect';
import { SessionRoots } from '@platform/rootedFs';
import {
  APPROVAL_POLICY_CONFIG_KEY,
  type ApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  APPROVAL_BYPASS_KINDS,
  NO_APPROVAL_GRANTS,
  resolveBypass,
  runPolicy,
  type ApprovalBypassKind,
  type ApprovalGrants,
  type ApprovalGrantSource,
  grantSource,
} from '@shared/approvalBypassKind';
import { bypassCovers, qualifyAggregateId, type RunId } from '@shared/schemas';
import {
  Unavailable,
  type RequestError,
  type RuntimeCommand,
} from '@shared/session/runtimeRequest';
import type { SessionApprovals } from '@shared/session/sessionApprovals';
import type { SessionEventDraft } from '@shared/schemas';
import { Settings } from '@shared/config/settings';
import { ancestryRows } from '@shared/session/runRelation';
import {
  Approvals,
  runStateAppend,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import type { SessionLogShape } from '@shared/session/sessionLog';
import { decideRequest } from './requests';

/**
 * A run's grants once it activates again, or null when they stand as
 * recorded. A goal's grant does not outlive the activation that armed it:
 * the run's own goal ends, and a kind an ancestor's goal grants it is marked
 * `parent`, derived rather than chosen: the run follows its ancestry's human
 * values for it, live, and no longer that goal, which is not this
 * activation's either.
 */
function afterActivation(
  source: ApprovalGrantSource<RunId>,
  runId: RunId,
  recorded: ApprovalGrants,
): ApprovalGrants | null {
  const pinned = APPROVAL_BYPASS_KINDS.filter(
    (kind) =>
      !recorded.goal.includes(kind) &&
      resolveBypass(source, runId, kind) === 'goal',
  );
  if (recorded.goal.length === 0 && pinned.length === 0) return null;
  const own = { ...recorded.own };
  for (const kind of pinned) own[kind] = 'parent';
  return { ...recorded, own, goal: [] };
}

const sameGrants = (a: ApprovalGrants, b: ApprovalGrants): boolean =>
  JSON.stringify([a.own, a.goal.toSorted(), a.limit]) ===
  JSON.stringify([b.own, b.goal.toSorted(), b.limit]);

/** The `approval.policy` row that records `snapshot` as a run's grants. */
const policyRow = (runId: RunId, snapshot: ApprovalGrants) => ({
  type: 'approval.policy' as const,
  aggregateId: qualifyAggregateId('run', runId),
  snapshot,
});

/** Whether `grants` turn `kind`'s bypass on by the run's own value or its
 *  goal's; a kind that follows the ancestry is read live, not here. */
const grantsOn = (grants: ApprovalGrants, kind: ApprovalBypassKind): boolean =>
  grants.own[kind] === 'on' || grants.goal.includes(kind);

/**
 * The approval of every open request a grant `next` of `runId` turns on
 * covers: the run's own, and those of the descendants whose edge stands
 * and whose grants follow its (`resolveBypass` over the grants as they
 * will be once `next` is recorded); decided in the transaction that
 * records the grant, so a person who answers "approve and stop asking"
 * answers what waits behind it too, down the tree. A request another
 * grant already covered, or one only a person answers, is left as it is.
 */
const approvalsUnder = Effect.fn('approvalsUnder')(function* (
  log: Pick<SessionLogShape, 'runRows' | 'facts'>,
  view: ApprovalGrantSource<RunId>,
  runId: RunId,
  recorded: ApprovalGrants,
  next: ApprovalGrants,
  /** The request the same batch decides on its own. */
  except?: string,
) {
  const turnedOn = APPROVAL_BYPASS_KINDS.filter(
    (kind) => grantsOn(next, kind) && !grantsOn(recorded, kind),
  );
  if (turnedOn.length === 0) return [];
  // The run and its descendants, by their standing parent edges.
  const reached = new Set([runId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, { parentId }] of view.runs)
      if (parentId !== null && reached.has(parentId) && !reached.has(id)) {
        reached.add(id);
        grew = true;
      }
  }
  // The grants as they will be once `next` is recorded, over each reached
  // run's committed grants, not the view's, which can lag a grant a run
  // turned off a moment ago.
  const policy = new Map(view.policy);
  for (const id of reached) {
    const grants = (yield* log.facts(id))?.grants;
    if (grants != null) policy.set(id, grants);
  }
  const after: ApprovalGrantSource<RunId> = {
    runs: view.runs,
    policy: policy.set(runId, next),
  };
  const rows: SessionEventDraft[] = [];
  for (const id of reached) {
    const covering = turnedOn.filter(
      (kind) => id === runId || resolveBypass(after, id, kind) !== null,
    );
    if (covering.length === 0) continue;
    const aggregateId = qualifyAggregateId('run', id);
    const { requests } = yield* log.runRows(aggregateId, 'requests');
    for (const [requestId, request] of Object.entries(requests))
      if (
        request.decision === null &&
        !(id === runId && requestId === except) &&
        covering.some((kind) => bypassCovers(kind, request.payload))
      )
        rows.push({
          type: 'request.decided',
          aggregateId,
          requestId,
          decision: { action: 'approve' },
        });
  }
  return rows;
});

/** The rows a change of `runId`'s grants writes: none when `edit` leaves
 *  them as recorded; else the `approval.policy` row and the approvals it
 *  answers ({@link approvalsUnder}). Read under the transaction's lock. */
const grantRows = Effect.fn('grantRows')(function* (
  log: Pick<SessionLogShape, 'runRows' | 'facts'>,
  view: ApprovalGrantSource<RunId>,
  runId: RunId,
  edit: (grants: ApprovalGrants) => ApprovalGrants,
  except?: string,
) {
  const recorded = (yield* log.facts(runId))?.grants ?? NO_APPROVAL_GRANTS;
  const next = edit(recorded);
  if (sameGrants(recorded, next)) return [];
  return [
    policyRow(runId, next),
    ...(yield* approvalsUnder(log, view, runId, recorded, next, except)),
  ];
});

/** The session's approvals over its view, its record door and its
 *  config. */
export const sessionApprovals: Effect.Effect<
  SessionApprovals,
  never,
  SessionViewAccess | SessionLog | SessionRoots
> = Effect.gen(function* () {
  const { ref } = yield* SessionViewAccess;
  const log = yield* SessionLog;
  const roots = yield* SessionRoots;
  const view = () => SubscriptionRef.getUnsafe(ref);
  const bypass: SessionApprovals['bypass'] = (runId, kind) =>
    resolveBypass(view(), runId, kind);
  return {
    bypass,
    policy: (runId) =>
      runPolicy(
        Settings.getConfig<ApprovalPolicy>(
          roots.config,
          APPROVAL_POLICY_CONFIG_KEY,
        ),
        view(),
        runId,
      ),
    activationRows: Effect.fn('activationRows')(function* (runId) {
      const source = grantSource(
        yield* ancestryRows((id) => log.facts(id), runId),
      );
      const next = afterActivation(
        source,
        runId,
        source.policy.get(runId) ?? NO_APPROVAL_GRANTS,
      );
      return next === null ? [] : [policyRow(runId, next)];
    }),
    change: (runId, edit, rows = []) => {
      // The view has applied every change by the time it returns, so a
      // change the view already shows writes nothing.
      const shown = view().policy.get(runId);
      if (
        rows.length === 0 &&
        shown !== undefined &&
        sameGrants(shown, edit(shown))
      )
        return Effect.void;
      return log.transact((tx) =>
        Effect.gen(function* () {
          const all: readonly SessionEventDraft[] = [
            ...rows,
            ...(yield* grantRows(log, view(), runId, edit)),
          ];
          if (all.length > 0) yield* runStateAppend(tx.append)(all);
        }),
      );
    },
    decideUnder: (runId, requestId, decision, edit) =>
      log.transact((tx) =>
        Effect.gen(function* () {
          const aggregateId = qualifyAggregateId('run', runId);
          const { requests } = yield* log.runRows(aggregateId, 'requests');
          const open = requests[requestId]?.decision === null;
          const all: readonly SessionEventDraft[] = [
            ...(open
              ? [
                  {
                    type: 'request.decided' as const,
                    aggregateId,
                    requestId,
                    decision,
                  },
                ]
              : []),
            ...(yield* grantRows(log, view(), runId, edit, requestId)),
          ];
          if (all.length > 0) yield* runStateAppend(tx.append)(all);
          return open;
        }),
      ),
  };
});

/** A human's value for some kinds of one run: it supersedes the run's goal
 *  grant of those kinds. */
export const humanGrant =
  (kinds: readonly ApprovalBypassKind[], enabled: boolean) =>
  (grants: ApprovalGrants): ApprovalGrants => ({
    ...grants,
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

/** How a session write the request made fails it: the `Unavailable` that
 *  `unavailable` describes, a closed run's included. */
export const writeRejection =
  (unavailable: ConstructorParameters<typeof Unavailable>[0]) =>
  (): RequestError =>
    new Unavailable(unavailable);

type PolicyChange = Extract<RuntimeCommand, { kind: 'policy.set' }>['change'];
type Answer<A, R> = Effect.Effect<A, RequestError, R>;

/** Whether `change` only narrows a run (a bypass off, a lower limit): open
 *  on any run, live or not, where a widening needs a working run's `grant`. */
export const narrows = (change: PolicyChange): boolean =>
  change.field === 'limit' || !change.enabled;

/**
 * Apply a grant change (a bypass, or a lower limit) once its `approval.policy`
 * row is durable, then `decide`, the decision it came with. Turning a bypass
 * on approves what else waits behind it in the grant's own transaction
 * (`approvalsUnder`).
 */
/** The edit a policy change makes to a run's grants: a limit only lowers;
 *  the delegated-work grant covers the command and edit grants too. */
const policyEdit = (
  change: PolicyChange,
): ((grants: ApprovalGrants) => ApprovalGrants) =>
  change.field === 'limit'
    ? (grants) => ({
        ...grants,
        limit:
          grants.limit === 'never' || change.limit === 'never'
            ? 'never'
            : 'ask',
      })
    : humanGrant(
        change.bypass === 'superYolo' ? APPROVAL_BYPASS_KINDS : [change.bypass],
        change.enabled,
      );

export function setPolicy<A, R>(
  change: PolicyChange,
  decide: Effect.Effect<A, RequestError, R>,
): Effect.Effect<A, RequestError, R | Approvals> {
  return Approvals.use((approvals) =>
    approvals.change(change.runId, policyEdit(change)),
  ).pipe(
    Effect.mapError(
      writeRejection({
        runId: change.runId,
        reason: 'The approval change could not be saved.',
      }),
    ),
    Effect.andThen(decide),
  );
}

/**
 * Decide `req` through `answer`, which `write`s it (did it land?) if it can
 * still be decided. With a `grant`, the decision and the grant are one
 * transaction (`Approvals.decideUnder`): the grant lands whatever the
 * request's state, so a request the run opens once it reads the decision
 * is approved as it opens.
 */
export const decideUnderGrant = <A, R>(
  req: Extract<RuntimeCommand, { kind: 'request.decide' }>,
  answer: (
    write: Effect.Effect<boolean, RequestError, SessionLog | Approvals>,
  ) => Answer<A, R>,
): Answer<A, R | Approvals | SessionLog> => {
  const { runId, requestId, decision, grant } = req;
  const rejected = writeRejection({
    runId,
    reason: 'The decision could not be recorded.',
  });
  const write: Effect.Effect<boolean, RequestError, SessionLog | Approvals> =
    grant == null
      ? decideRequest(runId, requestId, decision).pipe(
          Effect.mapError(rejected),
        )
      : Approvals.use((approvals) =>
          approvals.decideUnder(
            runId,
            requestId,
            decision,
            policyEdit({
              field: 'bypass',
              runId,
              bypass: grant,
              enabled: true,
            }),
          ),
        ).pipe(Effect.mapError(rejected));
  return answer(write);
};

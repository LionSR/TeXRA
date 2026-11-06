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
import {
  bypassCovers,
  qualifyAggregateId,
  type PermissionPayload,
  type RunId,
} from '@shared/schemas';
import {
  Unavailable,
  type RequestError,
  type RuntimeRequest,
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

/** Whether a request says only a person answers it (a hook's ask). */
const personOnly = (payload: PermissionPayload): boolean =>
  'allowBypass' in payload.data && !payload.data.allowBypass;

/**
 * The approval of every request of `runId` still open that a grant `next`
 * turns on covers: decided in the transaction that records the grant, so
 * a person who answers "approve and stop asking" answers what waits
 * behind it too. A request another grant already covered, or one only a
 * person answers, is left as it is.
 */
const approvalsUnder = Effect.fn('approvalsUnder')(function* (
  log: Pick<SessionLogShape, 'runRows'>,
  runId: RunId,
  recorded: ApprovalGrants,
  next: ApprovalGrants,
) {
  const turnedOn = APPROVAL_BYPASS_KINDS.filter(
    (kind) => grantsOn(next, kind) && !grantsOn(recorded, kind),
  );
  if (turnedOn.length === 0) return [];
  const aggregateId = qualifyAggregateId('run', runId);
  const { requests } = yield* log.runRows(aggregateId, 'requests');
  return Object.entries(requests).flatMap(([requestId, request]) =>
    request.decision === null &&
    !personOnly(request.payload) &&
    turnedOn.some((kind) => bypassCovers(kind, request.payload.kind))
      ? [
          {
            type: 'request.decided' as const,
            aggregateId,
            requestId,
            decision: { action: 'approve' as const },
          },
        ]
      : [],
  );
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
      // The claim holder's own grants are folded by the time each change
      // returns, so a change the view already shows writes nothing.
      const shown = view().policy.get(runId);
      if (
        rows.length === 0 &&
        shown !== undefined &&
        sameGrants(shown, edit(shown))
      )
        return Effect.void;
      return log.transact((tx) =>
        Effect.gen(function* () {
          const recorded =
            (yield* log.facts(runId))?.grants ?? NO_APPROVAL_GRANTS;
          const next = edit(recorded);
          const all: readonly SessionEventDraft[] = sameGrants(recorded, next)
            ? rows
            : [
                ...rows,
                policyRow(runId, next),
                ...(yield* approvalsUnder(log, runId, recorded, next)),
              ];
          if (all.length > 0) yield* runStateAppend(tx.append)(all);
        }),
      );
    },
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

type PolicyChange = Extract<RuntimeRequest, { kind: 'policy.set' }>['change'];
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
export function setPolicy<A, R>(
  change: PolicyChange,
  decide: Effect.Effect<A, RequestError, R>,
): Effect.Effect<A, RequestError, R | Approvals> {
  // A limit only lowers; the delegated-work grant covers the command and
  // edit grants too.
  const edit =
    change.field === 'limit'
      ? (grants: ApprovalGrants): ApprovalGrants => ({
          ...grants,
          limit:
            grants.limit === 'never' || change.limit === 'never'
              ? 'never'
              : 'ask',
        })
      : humanGrant(
          change.bypass === 'superYolo'
            ? APPROVAL_BYPASS_KINDS
            : [change.bypass],
          change.enabled,
        );
  return Approvals.use((approvals) =>
    approvals.change(change.runId, edit),
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
 * still be decided. Its `grant` lands first whatever the request's state, so
 * a request the run opens once it reads the decision is approved as it opens.
 */
export const decideUnderGrant = <A, R>(
  req: Extract<RuntimeRequest, { kind: 'request.decide' }>,
  answer: (
    write: Effect.Effect<boolean, RequestError, SessionLog>,
  ) => Answer<A, R>,
): Answer<A, R | Approvals | SessionLog> => {
  const { runId, requestId, decision, grant } = req;
  const write = decideRequest(runId, requestId, decision).pipe(
    Effect.mapError(
      writeRejection({
        runId,
        reason: 'The decision could not be recorded.',
      }),
    ),
  );
  return grant == null
    ? answer(write)
    : setPolicy(
        { field: 'bypass', runId, bypass: grant, enabled: true },
        answer(write),
      );
};

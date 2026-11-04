/**
 * The session's approvals: the prompt lanes, a run's grants, and how a
 * request's session write or claim fails it.
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
  DatabaseClaimRefused,
  heldElsewhereBy,
} from '@shared/session/database';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
  type RuntimeRequest,
} from '@shared/session/runtimeRequest';
import type {
  QueuedKind,
  SessionApprovals,
} from '@shared/session/sessionApprovals';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import { Settings } from '@shared/config/settings';
import { ancestryRows } from '@shared/session/runRelation';
import {
  Approvals,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { SessionRequests } from './requestPolicy';

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
  // One lane per kind and run, which the run's prompts take in turn;
  // `withPerKeyLane` drops a lane from its map once its last prompt settles.
  const lanes: Record<QueuedKind, Map<RunId, PerKeyLane>> = {
    bash: new Map(),
    toolEdit: new Map(),
  };
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
    enqueue: (kind, runId, approval) =>
      Effect.suspend(() =>
        approval.grant !== null && bypass(runId, approval.grant) !== null
          ? approval.bypassed
          : approval.prompt,
      ).pipe(withPerKeyLane(lanes[kind], runId)),
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
          const all: readonly UnfoldedDraft[] = sameGrants(recorded, next)
            ? rows
            : [...rows, policyRow(runId, next)];
          if (all.length > 0) yield* tx.append(all);
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

/** How a claim the request needed fails it: `Rejected`, in the claim's own
 *  words, when its holder could not be proven to have exited; else
 *  `NotOwner`, another owner holding the run. */
export const claimRejection =
  (runId: RunId) =>
  (error: unknown): RequestError =>
    error instanceof DatabaseClaimRefused && error.verdict === 'unprovable'
      ? new Rejected({ reason: error.message })
      : new NotOwner({ runId });

/** How a session write the request made fails it: {@link claimRejection}
 *  when another owner holds the run ({@link heldElsewhereBy}), else the
 *  `Unavailable` that `unavailable` describes, a closed run's included. */
export const writeRejection =
  (unavailable: ConstructorParameters<typeof Unavailable>[0]) =>
  (error: unknown): RequestError =>
    heldElsewhereBy(error) === null
      ? new Unavailable(unavailable)
      : claimRejection(unavailable.runId)(error);

type PolicyChange = Extract<RuntimeRequest, { kind: 'policy.set' }>['change'];
type Answer<A, R> = Effect.Effect<A, RequestError, R>;
type BypassChange = Extract<PolicyChange, { field: 'bypass' }>;

/**
 * Approve the run's requests pending under a bypass just turned on. Each
 * decision re-reads the rows, so one decided meanwhile keeps its answer; one
 * offering no grant (another tool's call, a hook's ask) waits for a person;
 * an edit's approval applies the user's edit; one still opening stays.
 */
const approvePendingUnderBypass = Effect.fn('approvePendingUnderBypass')(
  function* ({
    runId,
    bypass,
  }: BypassChange): Effect.fn.Return<
    void,
    RequestError,
    SessionViewAccess | SessionRequests
  > {
    const { ref } = yield* SessionViewAccess;
    const requests = yield* SessionRequests;
    yield* Effect.forEach(
      SubscriptionRef.getUnsafe(ref).requests.filter(
        ({ runId: requestRunId, payload }) =>
          requestRunId === runId &&
          bypassCovers(bypass, payload.kind) &&
          !('allowBypass' in payload.data && !payload.data.allowBypass),
      ),
      ({ requestId }) =>
        requests.decide(runId, requestId, { action: 'approve' }),
      { discard: true },
    ).pipe(
      Effect.mapError(
        writeRejection({
          runId,
          reason: 'The pending requests could not be approved.',
        }),
      ),
    );
  },
);

/** Whether `change` only narrows a run (a bypass off, a lower limit): open
 *  on any run, live or not, where a widening needs a working run's `grant`. */
export const narrows = (change: PolicyChange): boolean =>
  change.field === 'limit' || !change.enabled;

/**
 * Apply a grant change (a bypass, or a lower limit) once its `approval.policy`
 * row is durable, then `decide`, the decision it came with. Turning a bypass
 * on then approves what else waits behind it, on a run this process drives,
 * even when `decide` fails. The caller holds the run's claim.
 */
export function setPolicy<A, R>(
  change: PolicyChange,
  heldHere: boolean,
  decide: Effect.Effect<A, RequestError, R>,
): Effect.Effect<
  A,
  RequestError,
  R | Approvals | SessionViewAccess | SessionRequests
> {
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
    Effect.andThen(Effect.exit(decide)),
    // A run held elsewhere has no fiber here to act on a decision.
    Effect.tap(() =>
      change.field === 'bypass' && change.enabled && heldHere
        ? approvePendingUnderBypass(change)
        : Effect.void,
    ),
    Effect.flatten,
  );
}

/**
 * Decide `req` through `answer`, which `write`s it (did it land?) if it can
 * still be decided. Its `grant` lands first whatever the request's state, so
 * a request the run opens once it reads the decision is approved as it opens.
 */
export const decideUnderGrant = <A, R>(
  req: Extract<RuntimeRequest, { kind: 'request.decide' }>,
  heldHere: boolean,
  answer: (
    write: Effect.Effect<boolean, RequestError, SessionRequests>,
  ) => Answer<A, R>,
): Answer<A, R | Approvals | SessionViewAccess | SessionRequests> => {
  const { runId, requestId, decision, grant } = req;
  const write = SessionRequests.use((requests) =>
    requests.decide(runId, requestId, decision),
  ).pipe(
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
        heldHere,
        answer(write),
      );
};

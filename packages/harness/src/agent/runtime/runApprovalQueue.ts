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
 * (`SessionHandle.approvals`), never from context.
 */

import { Effect, SubscriptionRef } from 'effect';

import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';

import {
  APPROVAL_BYPASS_KINDS,
  NO_APPROVAL_GRANTS,
  policyLimit,
  resolveBypass,
  stricterPolicy,
  type ApprovalBypassKind,
  type ApprovalGrants,
  type ApprovalGrantSource,
} from '@shared/approvalBypassKind';
import {
  qualifyAggregateId,
  type PermissionPayload,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { writeRefused, type RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { readConfigSettingFrom } from '@utils/config/platformSettings';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import type { SessionHandle } from './SessionHandle';

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
type GrantWriteError =
  DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed;

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
  JSON.stringify([a.own, [...a.goal].sort(), a.limit]) ===
  JSON.stringify([b.own, [...b.goal].sort(), b.limit]);

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
   * changes of one run never lose each other's kind. `rows` commit in
   * the same transaction (a goal's row beside the grant it implies), and is
   * written even when the grants stand. The caller holds the run's claim.
   */
  change(
    runId: RunId,
    edit: (grants: ApprovalGrants) => ApprovalGrants,
    rows?: readonly SessionEventDraft[],
  ): Effect.Effect<void, GrantWriteError>;
  /**
   * The grants row a run's activation commits beside its `run.activate`, if
   * any (`afterActivation`), read from the rows of the run and its ancestry,
   * never from a view that may not have folded them yet.
   */
  activationRows(
    runId: RunId,
  ): Effect.Effect<readonly SessionEventDraft[], DatabaseReadFailed>;
  /**
   * The approval policy `runId`'s requests are decided under: this
   * process's override, else the project's persisted
   * `texra.approvalPolicy`, read at each call, narrowed by the strictest
   * launch limit on the run's ancestry (`policyLimit`). The persisted
   * setting is the one owner of a project's policy; a client changes it by
   * writing that setting, never by telling a session. Without a run, the
   * session's own policy.
   */
  policy(runId?: RunId): TexraApprovalPolicy;
  /**
   * Override the persisted policy for this process's own session (a CLI
   * invocation's `--approval-policy`, a chat's `/approval`); null follows
   * the setting again. The service never takes one: its sessions serve
   * every window of a project, so they follow the setting alone.
   */
  override(policy: TexraApprovalPolicy | null): void;
}

/** Build the session's approvals over its view, its record door and its
 *  config, read from `session` when first used. */
export function createSessionApprovals(
  session: () => Pick<SessionHandle, 'view' | 'log' | 'roots'>,
): SessionApprovals {
  const view = () => SubscriptionRef.getUnsafe(session().view.ref);
  // One exclusive lane per kind and run: the queue a run's prompts take in
  // turn. `withPerKeyLane` owns the entries, so a lane leaves its map once
  // its last prompt settles.
  const lanes: Record<QueuedKind, Map<RunId | undefined, PerKeyLane>> = {
    bash: new Map(),
    toolEdit: new Map(),
  };
  const bypass: SessionApprovals['bypass'] = (runId, kind) =>
    resolveBypass(view(), runId, kind);
  let overridden: TexraApprovalPolicy | null = null;
  return {
    bypass,
    policy: (runId) => {
      const policy =
        overridden ??
        readConfigSettingFrom<TexraApprovalPolicy>(
          session().roots.config,
          TEXRA_APPROVAL_POLICY_CONFIG_KEY,
        );
      const limit =
        runId === undefined ? undefined : policyLimit(view(), runId);
      return limit === undefined ? policy : stricterPolicy(policy, limit);
    },
    override: (next) => {
      overridden = next;
    },
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
          const rows: readonly SessionEvent[] =
            yield* session().log.records(id);
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
                aggregateId: qualifyAggregateId('run', runId),
                snapshot: next,
              },
            ];
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
      return session().log.transact((tx) =>
        Effect.gen(function* () {
          const recorded = recordedGrants(yield* session().log.records(runId));
          const next = edit(recorded);
          const policy: readonly SessionEventDraft[] = sameGrants(
            recorded,
            next,
          )
            ? []
            : [
                {
                  type: 'approval.policy',
                  aggregateId: qualifyAggregateId('run', runId),
                  snapshot: next,
                },
              ];
          if (rows.length + policy.length > 0)
            yield* tx.append([...rows, ...policy]);
        }),
      );
    },
  };
}

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

type BypassChange = Extract<RuntimeRequest, { kind: 'policy.set' }>['change'];

/** The request kinds each bypass covers. The delegated-work grant covers all
 *  three. A question, an inquiry, a retry and a plan approval never appear
 *  here: they need an answer, or carry their own credential semantics. */
const COVERED_KINDS: Record<
  ApprovalBypassKind,
  readonly PermissionPayload['kind'][]
> = {
  bash: ['bash'],
  toolEdit: ['toolEdit'],
  superYolo: ['proposal', 'toolEdit', 'bash'],
};

/**
 * Approve what waits behind a bypass that was just turned on: the run's
 * pending requests of the kinds it covers. Each decision re-reads the
 * committed rows in the session's publisher, so a request a surface decided
 * meanwhile is left with that surface's answer. The request the surface
 * decides itself (its own decision may carry more than a plain approval) is
 * left to it, a tool edit staged on a host is approved by that host with the
 * user's edits, and so is a bash command that is another tool's call, which
 * offers no bypass. A request whose opening is still committing is not
 * listed yet and stays pending for the user.
 */
function approvePendingUnderBypass(
  session: SessionHandle,
  { runId, bypass, exceptRequestId }: BypassChange,
): Effect.Effect<void, RequestError> {
  const kinds = COVERED_KINDS[bypass];
  return Effect.forEach(
    SubscriptionRef.getUnsafe(session.view.ref).requests.filter(
      ({ runId: requestRunId, requestId, payload }) =>
        requestRunId === runId &&
        requestId !== exceptRequestId &&
        kinds.includes(payload.kind) &&
        !(payload.kind === 'bash' && !payload.data.allowBypass),
    ),
    ({ requestId, payload }) =>
      // A tool edit a host staged a diff view for is approved with the
      // content the user edited there; the host answers `false` for one it
      // staged nothing for, which the payload decides.
      (payload.kind === 'toolEdit'
        ? session.interactions.approveToolEdit(requestId)
        : Effect.succeed(false)
      ).pipe(
        Effect.flatMap((hostDecided) =>
          hostDecided
            ? Effect.void
            : session.requests.decide(runId, requestId, { action: 'approve' }),
        ),
      ),
    { discard: true },
  ).pipe(
    Effect.mapError(
      writeRefused({
        runId,
        reason: 'The pending requests could not be approved.',
      }),
    ),
  );
}

/**
 * Apply a bypass change, acknowledged once its `approval.policy` row is
 * durable: the row is the grant, so nothing is held to undo when it does
 * not land. The caller holds the run's claim. Turning a bypass on then
 * approves what already waits behind it, on a run this process drives.
 */
export function setPolicy(
  session: SessionHandle,
  change: BypassChange,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError> {
  const { runId } = change;
  // The delegated-work grant covers the command and edit grants too.
  const kinds =
    change.bypass === 'superYolo' ? APPROVAL_BYPASS_KINDS : [change.bypass];
  return session.approvals
    .change(runId, humanGrant(kinds, change.enabled))
    .pipe(
      Effect.mapError(
        writeRefused({
          runId,
          reason: 'The approval change could not be saved.',
        }),
      ),
      // A run held elsewhere has no fiber here to act on a decision.
      Effect.andThen(
        change.enabled && heldHere
          ? approvePendingUnderBypass(session, change)
          : Effect.void,
      ),
      Effect.as({ kind: 'done' } as const),
    );
}

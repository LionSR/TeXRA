/**
 * The shape of a session's approvals: a run's grants and the one reading
 * of the policy. Built by `sessionApprovals` (`runApprovalQueue.ts`) and
 * `sessionPermission` (`loop/toolGuard.ts`); its tag is `Approvals`
 * (`shared/session/runHistory.ts`).
 */

import type {
  ApprovalBypassKind,
  ApprovalGrants,
} from '@shared/approvalBypassKind';
import type { ApprovalPolicy } from '@shared/approvalPolicy';
import type { RequestDecision, RunId, SessionRowDraft } from '@shared/schemas';
import type { Effect } from 'effect';
import type {
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from './database';
import type { UnfoldedDraft } from './sessionEvents';

/** Each operation a run asks permission for (the guard's `OPERATIONS`). */
export type ApprovalOperation =
  | 'bash'
  | 'call'
  | 'toolEdit'
  | 'plan'
  | 'proposal';

/** What a call's `PreToolUse` hooks answered, if anything. */
export type HookAnswer = 'allow' | 'ask' | undefined;

/**
 * The session's approvals: the run's grants. Enforcement reads
 * {@link bypass}; every change goes through {@link change}.
 */
export interface SessionApprovals {
  /** Who bypasses one kind's prompts for a run, read from the view. */
  bypass(runId: RunId, kind: ApprovalBypassKind): 'goal' | 'human' | null;
  /** Update grants in one transaction, returning once durable and folded.
   *  An unchanged grant writes nothing. A grant turned on answers every
   *  open request it covers in that transaction, unless the request says
   *  only a person answers it. Additional `rows` always commit in it. */
  change(
    runId: RunId,
    edit: (grants: ApprovalGrants) => ApprovalGrants,
    rows?: readonly UnfoldedDraft[],
  ): Effect.Effect<
    void,
    DatabaseAggregateClosed | DatabaseReadFailed | DatabaseWriteFailed
  >;
  /** Grants committed beside `run.activate`, read from the run's and its
   *  ancestors' rows, never from a view that may lag. */
  activationRows(
    runId: RunId,
  ): Effect.Effect<readonly SessionRowDraft[], DatabaseReadFailed>;
  /**
   * Record a surface's decision on `requestId` with the grant it came
   * with, in one transaction: the grant's rows land whatever the request's
   * state (so a request the run opens once it reads the decision is
   * approved as it opens), the decision only if the request is still open
   * (`false`: that lost race, or an id never opened), and the other open
   * requests the grant covers are approved beside it.
   */
  decideUnder(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
    edit: (grants: ApprovalGrants) => ApprovalGrants,
  ): Effect.Effect<
    boolean,
    DatabaseAggregateClosed | DatabaseReadFailed | DatabaseWriteFailed
  >;
  /**
   * The approval policy `runId`'s requests are decided under: the
   * project's persisted `approvalPolicy`, read at each call, narrowed
   * by the strictest launch limit on the run's ancestry (`runPolicy`).
   * The persisted setting is the one owner of a project's policy; a client
   * changes it by writing that setting, never by telling a session, and a
   * launch widens it only for its own run, by its grants (an Auto-approve
   * launch). Without a run, the project's policy.
   */
  policy(runId?: RunId): ApprovalPolicy;
}

/** The session's approvals, with the one reading of the policy
 *  (`sessionPermission`). */
export type ApprovalsWithPermission = SessionApprovals & {
  readonly permission: (
    runId: RunId,
    operation: ApprovalOperation,
    hook: HookAnswer,
  ) => 'allow' | 'ask' | { readonly action: 'deny'; readonly reason: string };
};

/**
 * The shape of a session's approvals: the prompt lanes, a run's grants, and
 * the one reading of the policy. Built by `createSessionApprovals`
 * (`runApprovalQueue.ts`) and `sessionPermission` (`loop/toolGuard.ts`);
 * its tag is `Approvals` (`approvalDecision.ts`).
 */

import type {
  ApprovalBypassKind,
  ApprovalGrants,
} from '@shared/approvalBypassKind';
import type { ApprovalPolicy } from '@shared/approvalPolicy';
import type { RunId, SessionEventDraft } from '@shared/schemas';
import type { Effect } from 'effect';
import type {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from './database';
import type { UnfoldedDraft } from './sessionEvents';

/**
 * One queued approval. A request can wait behind another prompt for long:
 * if the user turns its `grant` on meanwhile (say by answering the one
 * ahead with "approve and stop asking"), `bypassed` honours that decision
 * instead of prompting anyway.
 */
interface QueuedApproval<A, E, R> {
  /** The grant that answers the request instead, read as it reaches the
   *  head of its lane; null when only a person answers it. */
  readonly grant: ApprovalBypassKind | null;
  /** Open the request and wait for its decision. */
  readonly prompt: Effect.Effect<A, E, R>;
  /** Result used instead when `grant` is on by dispatch time. */
  readonly bypassed: Effect.Effect<A, E, R>;
}

/** The kinds whose prompts queue one at a time per run. */
export type QueuedKind = Extract<ApprovalBypassKind, 'bash' | 'toolEdit'>;

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
 * The session's approvals: prompt lanes and the run's grants. Enforcement
 * reads {@link bypass}; every change goes through {@link change}.
 */
export interface SessionApprovals {
  /** Serialize prompts per run and kind, checking each one's grant when it
   *  starts. */
  enqueue<A, E, R>(
    kind: QueuedKind,
    runId: RunId,
    approval: QueuedApproval<A, E, R>,
  ): Effect.Effect<A, E, R>;
  /** Who bypasses one kind's prompts for a run, read from the view. */
  bypass(runId: RunId, kind: ApprovalBypassKind): 'goal' | 'human' | null;
  /** Update grants in one transaction, returning once durable and folded.
   *  An unchanged grant writes nothing. Additional `rows` always commit in
   *  that transaction. The caller holds the run's claim. */
  change(
    runId: RunId,
    edit: (grants: ApprovalGrants) => ApprovalGrants,
    rows?: readonly UnfoldedDraft[],
  ): Effect.Effect<
    void,
    DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
  >;
  /** Grants committed beside `run.activate`, read from the run's and its
   *  ancestors' rows, never from a view that may lag. */
  activationRows(
    runId: RunId,
  ): Effect.Effect<readonly SessionEventDraft[], DatabaseReadFailed>;
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

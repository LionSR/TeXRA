/**
 * A bypass change and what it settles beside the grant itself: when it turns
 * a bypass on, the run's requests already waiting under it, on every host.
 */
import { Effect, SubscriptionRef } from 'effect';

import {
  humanGrant,
  type SessionApprovals,
} from '@agent/runtime/runApprovalQueue';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  APPROVAL_BYPASS_KINDS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import type { PermissionPayload } from '@shared/schemas';
import { writeRefused, type RequestError } from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';

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
    SubscriptionRef.getUnsafe(session.view).requests.filter(
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
            : session.decideRequest(runId, requestId, { action: 'approve' }),
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
  approvals: SessionApprovals,
  change: BypassChange,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError> {
  const { runId } = change;
  // The delegated-work grant covers the command and edit grants too.
  const kinds =
    change.bypass === 'superYolo' ? APPROVAL_BYPASS_KINDS : [change.bypass];
  return approvals.change(runId, humanGrant(kinds, change.enabled)).pipe(
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

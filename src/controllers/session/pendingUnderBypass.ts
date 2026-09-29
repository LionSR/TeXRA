/**
 * What turning a bypass on settles beside the flag itself: the run's requests
 * already waiting under it, on every host.
 */
import { Effect, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { PermissionPayload } from '@shared/schemas';
import { DatabaseNotOwner } from '@shared/session/database';
import {
  NotOwner,
  Unavailable,
  type RequestError,
} from '@shared/session/requestErrors';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';

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
export function approvePendingUnderBypass(
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
    Effect.mapError((error): RequestError =>
      error instanceof DatabaseNotOwner
        ? new NotOwner({ runId })
        : new Unavailable({
            runId,
            reason: 'The pending requests could not be approved.',
          }),
    ),
  );
}

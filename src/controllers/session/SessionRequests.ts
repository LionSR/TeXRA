/**
 * `SessionRequests`: one handler for every request a surface issues to its
 * session's runtime (PRD one-fold-three-renderers, 7.6 and 8.2). A request
 * is answered exactly once: an `Outcome` the host renders, or one of the
 * request errors. Existence is read from the log's sequence table before
 * any arm runs (contract C2: a stream exists iff its sequence row exists
 * and is not closed, minted synchronously by the publish of its `run.start`
 * and ahead of every fold), so a stop issued the moment a launch exposes its
 * stream is admitted; a stream with no row is `Unavailable`, never a defect
 * (a second surface can act from a view that has not yet folded a
 * `stream.removed`). Ownership comes from that same current sequence row:
 * a foreign claim
 * without a death proof is `NotOwner`. Display residency and historical
 * event writers never establish present ownership. A collaborator that
 * rejects is neither: the arms below reach one through `Effect.promise`, so
 * its rejection is a handler defect, and `SessionBridge` logs the cause
 * under the request id and answers `Internal`; the sender's latch clears
 * either way. A refusal this handler decides is a `RequestError`; a
 * collaborator breaking is not one to word. In process (the TUI,
 * headless) the Effect's own result is
 * the response; a bridge posts it as the `Response` of 8.4.
 *
 * Built per `SessionHandle` by `sessionLayer.ts`'s opener: it acts on
 * exactly the session it was built for.
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type {
  PlanApprovalResult,
  ProposalResult,
} from '@agent/runtime/HostInteractions';
import type { SessionGraph } from '@agent/runtime/sessionGraph';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { RunBusy } from '@agent/runtime/executionLanes';
import { aggregateId as qualifyAggregateId } from '@shared/schemas';
import type { LocalRuntimeState, StreamTabId } from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import {
  DatabaseClaimRefused,
  DatabaseWriteFailed,
  type AggregateState,
  type Database,
  type DeletionMode,
} from '@shared/session/database';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
} from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';

const done: Outcome = { kind: 'done' };

type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'readAll' | 'removeStream'
>;

/** The session's request handler, admitting on the log's sequence table. */
export function sessionRequests(
  session: SessionHandle,
  log: SessionRequestLog,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  inquiryRecords: Context.Service.Shape<typeof InquiryRecords>,
): SessionGraph['requests'] {
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeRequest,
  ) {
    const admitted = yield* admit(log, local, req);
    return yield* handle(session, req, log, admitted).pipe(
      Effect.provideService(InquiryRecords, inquiryRecords),
    );
  });
  const removeStream = Effect.fn('SessionRequests.removeStream')(function* (
    streamId: StreamTabId,
    mode: DeletionMode,
    expectedStartCommit: number,
  ) {
    const admitted = yield* admit(log, local, {
      kind: 'stream.delete',
      streamId,
    });
    if (admitted.startCommit !== expectedStartCommit) {
      return yield* Effect.fail(
        new Unavailable({
          streamId,
          reason: 'The run changed after it was listed.',
        }),
      );
    }
    return yield* deleteAdmittedStream(session, log, streamId, admitted, mode);
  });
  return { request, removeStream };
}

/** Admit against current sequence-row existence and claims. A foreign owner
 *  absent from the liveness snapshot is unprovable, so it cannot be admitted.
 *  Deletion uses the database transaction for its explicit single-run exception. */
function admit(
  log: Pick<Context.Service.Shape<typeof Database>, 'aggregateState'>,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  req: RuntimeRequest,
): Effect.Effect<AggregateState, RequestError> {
  // The stream a request acts on.
  const streamId =
    req.kind === 'policy.set' ? req.change.streamId : req.streamId;
  return Effect.flatMap(
    log.aggregateState([qualifyAggregateId('stream', streamId)]).pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    ),
    (state): Effect.Effect<AggregateState, RequestError> => {
      if (!state || state.closed) {
        return Effect.fail(
          new Unavailable({
            streamId,
            reason: 'The stream is no longer open.',
          }),
        );
      }
      const liveness = SubscriptionRef.getUnsafe(local);
      if (
        req.kind !== 'stream.delete' &&
        state.ownerId !== null &&
        !liveness.self.includes(state.ownerId) &&
        !liveness.dead.includes(state.ownerId)
      ) {
        return Effect.fail(new NotOwner({ streamId }));
      }
      return Effect.succeed(state);
    },
  );
}

/** A decision for a request no longer pending: settled already, or never made. */
function settled(streamId: StreamTabId, what: string): Unavailable {
  return new Unavailable({
    streamId,
    reason: `No pending ${what} request under that id.`,
  });
}

function planDecision(
  decision: Extract<RuntimeRequest, { kind: 'decision.plan' }>['decision'],
): PlanApprovalResult {
  switch (decision.action) {
    case 'approve':
      return { action: 'approve' };
    case 'approve_and_goal':
      return {
        action: 'approve_and_goal',
        ...(decision.autoApproveAll ? { autoApproveAll: true } : {}),
      };
    case 'reject':
      return { action: 'reject', feedback: decision.feedback ?? undefined };
  }
}

function proposalDecision(
  decision: Extract<RuntimeRequest, { kind: 'decision.proposal' }>['decision'],
): ProposalResult {
  switch (decision.action) {
    case 'approve':
      return {
        action: 'approve',
        ...(decision.model == null ? {} : { model: decision.model }),
        ...(decision.agent == null ? {} : { agent: decision.agent }),
      };
    case 'setup':
      return { action: 'setup' };
    case 'reject':
      return { action: 'reject', feedback: decision.feedback ?? undefined };
  }
}

/** Delete the admitted lifetime after acquiring its inactive execution slot. */
function deleteAdmittedStream(
  session: SessionHandle,
  log: SessionRequestLog,
  streamId: StreamTabId,
  admitted: AggregateState,
  mode: DeletionMode,
): Effect.Effect<Outcome, RequestError> {
  const aggregateId = qualifyAggregateId('stream', streamId);
  return Effect.gen(function* () {
    if (admitted.startCommit === null) {
      return yield* Effect.fail(
        new Unavailable({
          streamId: streamId,
          reason: 'The stream has no recorded start.',
        }),
      );
    }
    const [start] = yield* log
      .readAll(admitted.startCommit - 1, admitted.startCommit)
      .pipe(Effect.orDie);
    if (start?.type !== 'run.start' || start.aggregateId !== aggregateId) {
      return yield* Effect.fail(
        new Unavailable({
          streamId: streamId,
          reason: 'The stream start could not be read.',
        }),
      );
    }
    yield* session.executions
      .withInactiveExecutionStep(
        start.executionId,
        log.removeStream(aggregateId, mode, start.commit),
      )
      .pipe(
        Effect.mapError((error): RequestError => {
          if (error instanceof RunBusy) return new NotOwner({ streamId });
          if (
            error instanceof DatabaseWriteFailed &&
            error.cause instanceof DatabaseClaimRefused
          ) {
            return error.cause.verdict === 'alive'
              ? new NotOwner({ streamId })
              : new Rejected({
                  reason:
                    'The current owner could not be verified, so automatic or bulk deletion was refused.',
                });
          }
          return new Unavailable({
            streamId,
            reason: 'The stream could not be removed from the listing.',
          });
        }),
      );
    return { kind: 'deleted' as const, result: 'deleted' as const };
  });
}

function handle(
  session: SessionHandle,
  req: RuntimeRequest,
  log: SessionRequestLog,
  admitted: AggregateState,
): Effect.Effect<Outcome, RequestError, InquiryRecords> {
  switch (req.kind) {
    case 'stream.stop':
      return Effect.suspend(() =>
        session.executions.stopAgentStream(req.streamId, {
          detachActiveChildren: req.detachActiveChildren ?? undefined,
        }),
      ).pipe(Effect.as(done), Effect.uninterruptible);
    case 'stream.delete':
      return deleteAdmittedStream(
        session,
        log,
        req.streamId,
        admitted,
        'single',
      );
    case 'stream.compact':
      return Effect.suspend((): Effect.Effect<Outcome, RequestError> => {
        const result = session.executions.requestManualCompaction(req.streamId);
        switch (result.kind) {
          case 'requested':
            return Effect.succeed(done);
          case 'unsupported':
            return Effect.fail(
              new Rejected({
                reason:
                  'Manual context compaction is not available for this model yet.',
              }),
            );
          case 'no_active_tool_use':
            return Effect.fail(
              new Unavailable({
                streamId: req.streamId,
                reason: 'No active tool-use session found for this stream.',
              }),
            );
        }
      });
    case 'followUp.send':
      return submitFollowUp(
        req.streamId,
        {
          text: req.text,
          ...(req.displayText == null ? {} : { displayText: req.displayText }),
          ...(req.mediaFiles == null ? {} : { mediaFiles: req.mediaFiles }),
        },
        { session },
      ).pipe(
        Effect.orDie,
        Effect.flatMap((result) =>
          result.status === 'failed'
            ? Effect.fail(
                new Unavailable({
                  streamId: req.streamId,
                  reason: result.reason,
                }),
              )
            : Effect.succeed<Outcome>({
                kind: 'followUp',
                status: result.status,
                ...(result.status === 'queued' && result.wake === 'failed'
                  ? { wake: 'failed' }
                  : {}),
              }),
        ),
      );
    case 'decision.bash':
      return Effect.suspend(() =>
        session.interactions.settleRequest(
          'bash',
          req.approvalId,
          req.decision.action === 'approve'
            ? { action: 'approve' }
            : {
                action: 'reject',
                feedback: req.decision.feedback ?? undefined,
              },
        )
          ? Effect.succeed(done)
          : Effect.fail(settled(req.streamId, 'bash approval')),
      );
    case 'decision.plan':
      return Effect.suspend(() =>
        session.interactions.settleRequest(
          'planApproval',
          req.approvalId,
          planDecision(req.decision),
        )
          ? Effect.succeed(done)
          : Effect.fail(settled(req.streamId, 'plan approval')),
      );
    case 'decision.proposal':
      return Effect.suspend(() =>
        session.interactions.settleRequest(
          'proposal',
          req.approvalId,
          proposalDecision(req.decision),
        )
          ? Effect.succeed(done)
          : Effect.fail(settled(req.streamId, 'proposal')),
      );
    case 'decision.userQuestion':
      return Effect.suspend(() =>
        session.interactions.settleRequest(
          'userQuestion',
          req.approvalId,
          req.decision.action === 'submit'
            ? { action: 'submit', answers: req.decision.answers }
            : {
                action: req.decision.action,
                feedback: req.decision.feedback ?? undefined,
              },
        )
          ? Effect.succeed(done)
          : Effect.fail(settled(req.streamId, 'user question')),
      );
    case 'decision.retry':
      // A rejection from the run's client preparation is a handler defect,
      // per the module contract above, not a `RequestError` to word.
      return Effect.promise(() =>
        session.interactions.settleRetry(
          req.approvalId,
          req.decision.action === 'retry'
            ? {
                action: 'retry',
                ...(req.decision.feedback == null
                  ? {}
                  : { feedback: req.decision.feedback }),
              }
            : { action: 'cancel' },
          req.decision.action === 'retry'
            ? (req.decision.credentials ?? 'configured')
            : 'configured',
        ),
      ).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.succeed(done)
            : Effect.fail(settled(req.streamId, 'retry')),
        ),
      );
    case 'externalInquiry.submit':
    case 'externalInquiry.drop':
      return handleExternalInquiryAction(
        req.kind === 'externalInquiry.submit'
          ? {
              action: 'submit',
              threadId: req.threadId,
              turnIndex: req.turnIndex,
              answer: req.answer,
              ...(req.sessionLinks == null
                ? {}
                : { sessionLinks: req.sessionLinks }),
            }
          : {
              action: 'drop',
              threadId: req.threadId,
              turnIndex: req.turnIndex,
              ...(req.feedback == null ? {} : { feedback: req.feedback }),
            },
        { session },
      ).pipe(
        Effect.orDie,
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.succeed(done)
            : Effect.fail(
                new Unavailable({
                  streamId: req.streamId,
                  reason: 'This inquiry turn is no longer open.',
                }),
              ),
        ),
      );
    case 'policy.set':
      return Effect.sync(() => {
        const { change } = req;
        switch (change.bypass) {
          case 'bash':
            session.approvals.bash.bypass.setBypass(
              change.streamId,
              change.enabled,
            );
            break;
          case 'toolEdit':
            session.approvals.toolEdit.bypass.setBypass(
              change.streamId,
              change.enabled,
            );
            break;
          case 'superYolo':
            session.approvals.setDelegatedWorkBypasses(
              change.streamId,
              change.enabled,
            );
            break;
        }
        return done;
      });
    case 'workflow.control':
      // A settled call, or an id no live run of this session owns, acted on
      // nothing: the surface hears that, never a `done`.
      return session.workflowControls.control(req.executionId, req.action)
        ? Effect.succeed(done)
        : Effect.fail(
            new Unavailable({
              streamId: req.streamId,
              reason: 'No live call under that execution id.',
            }),
          );
  }
}

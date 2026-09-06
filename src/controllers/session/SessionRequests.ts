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
 * `stream.removed`). Ownership is read from the view: a stream another live
 * process holds (`readOnly`) is `NotOwner`. In process (the TUI, headless) the Effect's own result is
 * the response; a bridge posts it as the `Response` of 8.4.
 *
 * Built per `SessionHandle` by `sessionLayer.ts`'s opener: it acts on
 * exactly the session it was built for.
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import type { SessionStores } from '@agent/storage';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type {
  PlanApprovalResult,
  ProposalResult,
} from '@agent/runtime/HostInteractions';
import type { SessionEventLog } from '@agent/runtime/SessionEvents';
import type { SessionGraph } from '@agent/runtime/sessionGraph';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
} from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import { createSessionStores } from './createSessionStores';

const done: Outcome = { kind: 'done' };

/** The session's request handler, admitting on the log's sequence table. */
export function sessionRequests(
  session: SessionHandle,
  log: Pick<Context.Service.Shape<typeof SessionEventLog>, 'exists'>,
): SessionGraph['requests'] {
  // The store lifecycle owner, built on the first request that deletes: it
  // holds the deletion queues, which only those need.
  let stores: SessionStores | undefined;
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeRequest,
  ) {
    yield* admit(session, log, req);
    return yield* handle(
      session,
      () => (stores ??= createSessionStores(session)),
      req,
    );
  });
  return { request };
}

/** Existence from the log's sequence table, ownership from the view: no
 *  row is `Unavailable`, held elsewhere is `NotOwner`. A stream the view
 *  has not folded yet is held by nobody this process knows of. A deletion
 *  is admitted for a held stream: it acts on storage the lease protocol
 *  guards, not on the run. */
function admit(
  session: SessionHandle,
  log: Pick<Context.Service.Shape<typeof SessionEventLog>, 'exists'>,
  req: RuntimeRequest,
): Effect.Effect<void, RequestError> {
  // The stream a request acts on.
  const streamId =
    req.kind === 'policy.set' ? req.change.streamId : req.streamId;
  return Effect.flatMap(
    log.exists(streamId),
    (exists): Effect.Effect<void, RequestError> => {
      if (!exists) {
        return Effect.fail(
          new Unavailable({
            streamId,
            reason: 'The stream is no longer open.',
          }),
        );
      }
      const stream = SubscriptionRef.getUnsafe(session.view).streams.get(
        streamId,
      );
      if (stream?.readOnly && req.kind !== 'stream.delete') {
        return Effect.fail(new NotOwner({ streamId }));
      }
      return Effect.void;
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

function handle(
  session: SessionHandle,
  stores: () => SessionStores,
  req: RuntimeRequest,
): Effect.Effect<Outcome, RequestError> {
  switch (req.kind) {
    case 'stream.stop':
      return Effect.sync(() => {
        session.executions.stopAgentStream(req.streamId, {
          detachActiveChildren: req.detachActiveChildren ?? undefined,
        });
        return done;
      });
    case 'stream.delete':
      return Effect.promise(() => stores().deleteStream(req.streamId)).pipe(
        Effect.map((result): Outcome => ({ kind: 'deleted', result })),
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
      return Effect.promise(() =>
        submitFollowUp(
          req.streamId,
          {
            text: req.text,
            ...(req.displayText == null
              ? {}
              : { displayText: req.displayText }),
            ...(req.mediaFiles == null ? {} : { mediaFiles: req.mediaFiles }),
          },
          { session },
        ),
      ).pipe(
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
      return Effect.promise(() =>
        handleExternalInquiryAction(
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
        ),
      ).pipe(
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

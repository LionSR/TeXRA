/**
 * `SessionRequests`: one handler for every request a surface issues to its
 * session's runtime (PRD one-fold-three-renderers, 7.6 and 8.2). A request
 * is answered exactly once: an `Outcome` the host renders, or one of the
 * request errors. Ownership is read from the session's view before any arm
 * runs: a stream the view does not hold is `Unavailable`, never a defect
 * (a second surface can act from a view that has not yet folded a
 * `stream.removed`), and a stream another live process holds (`readOnly`)
 * is `NotOwner`. In process (the TUI, headless) the Effect's own result is
 * the response; a bridge posts it as the `Response` of 8.4.
 *
 * Built per `SessionHandle` by `sessionLayer.ts`'s opener, under the
 * handle's scope: it acts on exactly the session it was built for.
 */
import { Context, Effect, Layer, SubscriptionRef } from 'effect';

import type { SessionStores } from '@agent/storage';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type {
  PlanApprovalResult,
  ProposalResult,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
} from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { createSessionStores } from './createSessionStores';

const done: Outcome = { kind: 'done' };

export class SessionRequests extends Context.Service<
  SessionRequests,
  {
    readonly request: (
      req: RuntimeRequest,
    ) => Effect.Effect<Outcome, RequestError>;
  }
>()('@texra/session/SessionRequests') {
  static layer(session: SessionHandle): Layer.Layer<SessionRequests> {
    return Layer.effect(
      SessionRequests,
      Effect.sync(() => {
        // The store lifecycle owner, built on the first request that
        // deletes: it holds the deletion queues, which only those need.
        let stores: SessionStores | undefined;
        const request = Effect.fn('SessionRequests.request')(function* (
          req: RuntimeRequest,
        ) {
          yield* admit(session, req);
          return yield* handle(
            session,
            () => (stores ??= createSessionStores(session)),
            req,
          );
        });
        return { request };
      }),
    );
  }
}

/** The stream a request acts on, or null for a session operation. */
function targetStream(req: RuntimeRequest): StreamTabId | null {
  switch (req.kind) {
    case 'stream.deleteAll':
      return null;
    case 'policy.set':
      return req.change.field === 'bypass' ? req.change.streamId : null;
    default:
      return req.streamId;
  }
}

/** Ownership, from the view: absent is `Unavailable`, held elsewhere is
 *  `NotOwner`. A deletion is admitted for a held stream: it acts on storage
 *  the lease protocol guards, not on the run. */
function admit(
  session: SessionHandle,
  req: RuntimeRequest,
): Effect.Effect<void, RequestError> {
  const streamId = targetStream(req);
  if (streamId === null) return Effect.void;
  const stream = SubscriptionRef.getUnsafe(session.view).streams.get(streamId);
  if (!stream) {
    return Effect.fail(
      new Unavailable({ streamId, reason: 'The stream is no longer open.' }),
    );
  }
  if (stream.readOnly && req.kind !== 'stream.delete') {
    return Effect.fail(new NotOwner({ streamId }));
  }
  return Effect.void;
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
    case 'stream.deleteAll':
      return Effect.promise(() => stores().deleteAll()).pipe(
        Effect.map((result): Outcome => ({
          kind: 'deletedAll',
          deleted: result.deleted.size,
          active: result.active.size,
          failed: result.failed.size,
        })),
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
      return Effect.suspend(() =>
        session.interactions.settleRequest(
          'retry',
          req.approvalId,
          req.decision.action === 'retry'
            ? {
                action: 'retry',
                ...(req.decision.feedback == null
                  ? {}
                  : { feedback: req.decision.feedback }),
              }
            : { action: 'cancel' },
        )
          ? Effect.succeed(done)
          : Effect.fail(settled(req.streamId, 'retry')),
      );
    case 'policy.set':
      return Effect.sync(() => {
        const { change } = req;
        if (change.field === 'policy') {
          session.setApprovalPolicy(change.policy);
          return done;
        }
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
      return Effect.sync(() => {
        session.workflowControls.control(
          req.executionId as Parameters<
            SessionHandle['workflowControls']['control']
          >[0],
          req.action,
        );
        return done;
      });
  }
}

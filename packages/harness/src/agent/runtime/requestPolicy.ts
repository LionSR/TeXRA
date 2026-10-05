/**
 * What the session's approval policy settles when a request opens, decided in
 * core so that `yolo` and `never` mean one thing on every host. The answer is
 * recorded as the `request.decided` row beside the request's own
 * `request.opened`, in the same batch, so no surface ever lists it pending.
 *
 * A command or edit reaches the session's door already decided by its tool,
 * which alone holds the approvals setting and the run's scoped bypass, and a
 * delegation proposal by its flow (`proposalFlow.ts`, `yolo` included); those
 * present.
 */

import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
  texraHumanInputDenialMessage,
  texraRetryDenialMessage,
  type ApprovalPolicyDenial,
} from '@shared/approvalPolicy';
import {
  aggregateId as qualifyAggregateId,
  isCredentialRetryFailure,
  type PermissionPayload,
  type RequestDecision,
  type RunId,
} from '@shared/schemas';
import type { RunHistoryDraft } from '@shared/session/runStateFold';

import type { StepToolInputs } from './agentToolResolution';
import type { SessionHandle } from './SessionHandle';

/** What the session's host can answer, read live: a host attached after a
 *  run started still answers for it. */
const canPresent = (session: SessionHandle): boolean =>
  !session.interactions.approvalPromptsUnavailable;

/**
 * The policy's answer for an executable request (a plan, or any
 * approval-gated tool) under what the host can answer. One reading for
 * every run of the session, whoever triggers it.
 */
const executableDecision = (session: SessionHandle) =>
  decideTexraApproval({
    policy: session.approvalPolicy,
    promptRequired: true,
    scopedBypass: false,
    canPresent: canPresent(session),
  });

/** The policy's answer for one request: a plan follows the executable rule
 *  (`never` denies, `yolo` approves, `ask` presents or, with nobody to ask,
 *  denies), and a question or a retry is denied under `yolo` rather than
 *  answered on a person's behalf. */
function answerFor(
  session: SessionHandle,
  payload: PermissionPayload,
):
  | {
      readonly decision: RequestDecision;
      readonly denial?: ApprovalPolicyDenial;
    }
  | undefined {
  const policy = session.approvalPolicy;
  switch (payload.kind) {
    case 'planApproval': {
      const decision = executableDecision(session);
      if (decision === 'present') return undefined;
      if (decision === 'allow') return { decision: { action: 'approve' } };
      return {
        decision: {
          action: 'deny',
          reason: texraApprovalDenialMessage(decision),
        },
        denial: { kind: 'plan' },
      };
    }
    case 'userQuestion':
    case 'toolOutcome': {
      const decision = decideHumanInputRequest({
        policy,
        canPresent: canPresent(session),
      });
      if (decision === 'present') return undefined;
      return {
        decision: {
          action: 'deny',
          reason: texraHumanInputDenialMessage(decision.deny),
        },
        denial: { kind: 'humanInput', deny: decision.deny },
      };
    }
    case 'retry': {
      const decision = decideRetryApproval({
        policy,
        canPresent: canPresent(session),
        isCredentialFailure: isCredentialRetryFailure(
          payload.data.errorDetails,
        ),
      });
      if (decision === 'present') return undefined;
      return {
        decision: {
          action: 'deny',
          reason: texraRetryDenialMessage(decision.deny),
        },
        denial: { kind: 'retry', deny: decision.deny },
      };
    }
    case 'proposal':
    case 'toolEdit':
    case 'bash':
    case 'externalInquiry':
      return undefined;
  }
}

/**
 * The rows that record the policy's answer beside a request about to open:
 * none when a surface decides. A denial is told to the attached host as the
 * request opens.
 */
export function policyDecidedRows(
  session: SessionHandle,
  runId: RunId,
  payload: PermissionPayload,
): Extract<RunHistoryDraft, { type: 'request.decided' }>[] {
  const answer = answerFor(session, payload);
  if (answer === undefined) return [];
  if (answer.denial) session.interactions.approvalDenied(answer.denial, runId);
  return [
    {
      type: 'request.decided',
      aggregateId: qualifyAggregateId('run', runId),
      requestId: payload.data.requestId,
      decision: answer.decision,
    },
  ];
}

/** The step's inputs read live from its session: whether approvals can be
 *  asked, and what its host serves now. */
export function liveToolGates(
  session: SessionHandle,
): Pick<StepToolInputs, 'approvalPromptsUnavailable' | 'hostCapabilities'> {
  return {
    approvalPromptsUnavailable: isTexraApprovalDenied(
      executableDecision(session),
    ),
    hostCapabilities: new Set(
      session.interactions.readDiagnostics ? ['diagnostics'] : [],
    ),
  };
}

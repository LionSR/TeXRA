/**
 * Shared CLI settlement of TeXRA policy decisions into host results.
 *
 * Decision authority is `@shared/approvalPolicy`; this module only maps
 * decisions into CLI shapes and warns once when policy closes a gate.
 * Both the headless adapter and the TUI import from here — do not duplicate
 * settle helpers in the adapters.
 */

import { type SessionHandle } from '@agent/runtime';
import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
  texraHumanInputDenialMessage,
  texraRetryDenialMessage,
  type TexraApprovalPolicy,
  type TexraApprovalPolicyDecision,
} from '@shared/approvalPolicy';
import {
  isCredentialExhausted,
  type RequestDecision,
  type RetryPermission,
  type RunId,
} from '@shared/schemas';

import { type CliContext } from '../cliContext';

import { policyDenialOf, warnApprovalDenied } from './approvalPrompts';

function canPresent(context: CliContext): boolean {
  return context.mode === 'interactive';
}

/**
 * The policy decision for a gated Bash or tool-edit request in this CLI run.
 * Host requests arrive only after shared settings and scoped bypasses have
 * kept the action gated, so both request facts are fixed here.
 */
function executableDecision(
  context: CliContext,
  policy: TexraApprovalPolicy,
): TexraApprovalPolicyDecision {
  return decideTexraApproval({
    policy,
    promptRequired: true,
    scopedBypass: false,
    canPresent: canPresent(context),
  });
}

/**
 * The approval options of every CLI tool-use launch. When this run can never
 * present an approval prompt, the runtime withholds approval-gated tools up
 * front rather than let each request settle as denied; a policy denial warns
 * once. The policy is the session's at launch, the one the run is pinned to.
 */
export function cliToolUseApprovalOptions(
  session: SessionHandle,
  context: CliContext,
  runId?: RunId,
): {
  readonly approvalPromptsUnavailable: boolean;
  readonly onApprovalPolicyDenial: (withheldTools?: readonly string[]) => void;
} {
  return {
    approvalPromptsUnavailable: isTexraApprovalDenied(
      executableDecision(context, session.approvalPolicy),
    ),
    onApprovalPolicyDenial: (withheldTools) =>
      warnApprovalDenied(
        session,
        context,
        policyDenialOf(withheldTools),
        runId,
      ),
  };
}

/** The policy's answer for a gated executable request, or `undefined` to
 *  prompt: one arm of the request vocabulary, decided on the spot. */
export function settleExecutable(
  session: SessionHandle,
  context: CliContext,
  runId?: RunId | '',
): RequestDecision | undefined {
  const decision = executableDecision(context, session.approvalPolicy);
  if (decision === 'allow') return { action: 'approve' };
  if (decision === 'present') return undefined;
  warnApprovalDenied(session, context, { kind: 'executable' }, runId);
  return { action: 'deny', reason: texraApprovalDenialMessage(decision) };
}

function isCredentialRetryFailure(payload: RetryPermission): boolean {
  const details = payload.errorDetails;
  if (!details) return false;
  if (isCredentialExhausted(details)) return true;
  return details.statusCode === 401 || details.statusCode === 403;
}

/** Settle a retry decision, or `undefined` to prompt. */
export function settleRetry(
  session: SessionHandle,
  payload: RetryPermission,
  context: CliContext,
): RequestDecision | undefined {
  const retryDecision = decideRetryApproval({
    policy: session.approvalPolicy,
    canPresent: canPresent(context),
    isCredentialFailure: isCredentialRetryFailure(payload),
  });
  if (retryDecision === 'present') return undefined;
  // Under yolo the TUI shows the failed run itself; a headless run would
  // otherwise end on the model error with no word that no retry was tried.
  if (retryDecision.deny !== 'yolo-retry' || context.mode === 'headless') {
    warnApprovalDenied(
      session,
      context,
      { kind: 'retry', deny: retryDecision.deny },
      payload.runId,
    );
  }
  return {
    action: 'deny',
    reason: texraRetryDenialMessage(retryDecision.deny),
  };
}

/**
 * Settle a human-input denial, or `undefined` when a prompt is allowed.
 * Callers wrap `reason` into their host-specific settlement shape.
 */
export function settleHumanInputDenial(
  session: SessionHandle,
  context: CliContext,
  runId?: RunId | '',
): { readonly reason: string } | undefined {
  const decision = decideHumanInputRequest({
    policy: session.approvalPolicy,
    canPresent: canPresent(context),
  });
  if (decision === 'present') return undefined;
  if (decision.deny !== 'yolo-no-human') {
    warnApprovalDenied(session, context, { kind: 'humanInput' }, runId);
  }
  return {
    reason: texraHumanInputDenialMessage(decision.deny),
  };
}

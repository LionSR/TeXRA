/**
 * Shared CLI settlement of TeXRA policy decisions into host results.
 *
 * Decision authority is `@shared/approvalPolicy`; this module only maps
 * decisions into CLI shapes and warns once when policy closes a gate.
 * Both the headless adapter and the TUI import from here — do not duplicate
 * settle helpers in the adapters.
 */

import { defaultSession } from '@agent/runtime';
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

import { warnApprovalDenied } from './approvalPrompts';

function livePolicy(): TexraApprovalPolicy {
  return defaultSession().approvalPolicy;
}

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
  policy: TexraApprovalPolicy = livePolicy(),
): TexraApprovalPolicyDecision {
  return decideTexraApproval({
    policy,
    promptRequired: true,
    scopedBypass: false,
    canPresent: canPresent(context),
  });
}

/**
 * Whether this run can never present an approval prompt, so the runtime should
 * withhold approval-gated tools up front rather than let each request settle as
 * denied. Callers pass the launch-time policy the run is pinned to.
 */
export function cliApprovalPromptsUnavailable(
  context: CliContext,
  policy: TexraApprovalPolicy,
): boolean {
  return isTexraApprovalDenied(executableDecision(context, policy));
}

/** The policy's answer for a gated executable request, or `undefined` to
 *  prompt: one arm of the request vocabulary, decided on the spot. */
export function settleExecutable(
  context: CliContext,
  runId?: RunId | '',
): RequestDecision | undefined {
  const decision = executableDecision(context);
  if (decision === 'allow') return { action: 'approve' };
  if (decision === 'present') return undefined;
  warnApprovalDenied(context, 'Approval policy', runId);
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
  payload: RetryPermission,
  context: CliContext,
): RequestDecision | undefined {
  const retryDecision = decideRetryApproval({
    policy: livePolicy(),
    canPresent: canPresent(context),
    isCredentialFailure: isCredentialRetryFailure(payload),
  });
  if (retryDecision === 'present') return undefined;
  if (retryDecision.deny !== 'yolo-retry') {
    warnApprovalDenied(
      context,
      retryDecision.deny === 'credential'
        ? 'Credential-exhausted retry'
        : 'Approval policy',
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
  context: CliContext,
  runId?: RunId | '',
): { readonly reason: string } | undefined {
  const decision = decideHumanInputRequest({
    policy: livePolicy(),
    canPresent: canPresent(context),
  });
  if (decision === 'present') return undefined;
  if (decision.deny !== 'yolo-no-human') {
    warnApprovalDenied(context, 'Human-input request', runId);
  }
  return {
    reason: texraHumanInputDenialMessage(decision.deny),
  };
}

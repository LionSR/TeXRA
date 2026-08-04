/**
 * Shared CLI settlement of TeXRA policy decisions into host results.
 *
 * Decision authority is `@shared/approvalPolicy`; this module only maps
 * decisions into CLI shapes and marks `context.approvalDenied` when needed.
 * Both the headless adapter and the TUI import from here — do not duplicate
 * settle helpers in the adapters.
 */

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  decideHumanInputRequest,
  decideRetryApproval,
  decideTexraApproval,
  texraApprovalDenialMessage,
  texraHumanInputDenialMessage,
  texraRetryDenialMessage,
} from '@shared/approvalPolicy';
import {
  isCredentialExhausted,
  type ApprovalDecision,
  type RetryPermission,
} from '@shared/schemas';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { type CliContext } from '../cliContext';

import { markApprovalDenied } from './approvalPrompts';

const EXTERNAL_INQUIRY_YOLO_MESSAGE =
  'External inquiry requires human input; yolo mode cannot synthesize an external answer.';

function livePolicy() {
  return defaultSession().approvalPolicy;
}

function canPresent(context: CliContext): boolean {
  return context.mode === 'interactive';
}

/** Settle a shared executable decision into a CLI approval result, or `undefined` to prompt. */
export function settleExecutable(
  context: CliContext,
): ApprovalDecision | undefined {
  const decision = decideTexraApproval({
    policy: livePolicy(),
    promptRequired: true,
    scopedBypass: false,
    canPresent: canPresent(context),
  });
  if (decision === 'allow') return { accepted: true };
  if (decision === 'present') return undefined;
  markApprovalDenied(context);
  return {
    accepted: false,
    userMessage: texraApprovalDenialMessage(decision),
  };
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
): ApprovalDecision | undefined {
  const retryDecision = decideRetryApproval({
    policy: livePolicy(),
    canPresent: canPresent(context),
    isCredentialFailure: isCredentialRetryFailure(payload),
  });
  if (retryDecision === 'present') return undefined;
  if (retryDecision.deny !== 'yolo-retry') {
    markApprovalDenied(context);
  }
  return {
    accepted: false,
    userMessage: texraRetryDenialMessage(retryDecision.deny),
  };
}

/**
 * Settle a human-input denial, or `undefined` when a prompt is allowed.
 * Callers wrap `userMessage` into their host-specific settlement shape.
 */
export function settleHumanInputDenial(
  context: CliContext,
  yoloMessage?: string,
): { readonly userMessage: string } | undefined {
  const decision = decideHumanInputRequest({
    policy: livePolicy(),
    canPresent: canPresent(context),
  });
  if (decision === 'present') return undefined;
  if (decision.deny !== 'yolo-no-human') {
    markApprovalDenied(context);
  }
  return {
    userMessage: texraHumanInputDenialMessage(decision.deny, yoloMessage),
  };
}

/**
 * "No human input available" guard for external-inquiry requests, used by the
 * TUI approval queue (`subscribeApprovals.ts`). Drops the durable inquiry
 * thread with denial feedback and returns `true` when denied; returns `false`
 * when a prompt is allowed and the caller should proceed with its own
 * handling. Non-TUI runs never reach here — the headless interaction port
 * drops the thread itself (`approvalAdapter.openExternalInquiry`).
 */
export function denyExternalInquiryIfNoHumanInput(
  threadId: string,
  context: CliContext,
): boolean {
  const denial = settleHumanInputDenial(context, EXTERNAL_INQUIRY_YOLO_MESSAGE);
  if (denial == null) return false;
  void handleExternalInquiryAction({
    action: 'drop',
    threadId,
    feedback: denial.userMessage,
  });
  return true;
}

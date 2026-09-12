import { Effect } from 'effect';

import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import {
  getRunContextRunId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  BASH_APPROVAL_CONFIG_KEY,
  type BashPermission,
  type RequestDecision,
  type RequestRefusal,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import {
  decideTexraApproval,
  isTexraApprovalDenied,
  texraApprovalDenialMessage,
} from '@shared/approvalPolicy';
import { refusalCopy, refusalOf } from '@shared/session/approvalDecision';
import { requireInteractions } from '@tools/contextHelpers';
import { errorResult } from '@tools/core/result';
import { generateShortId } from '@utils/core';
import { getConfig } from '@utils/config/configUtils';
import { previewLabel } from '@utils/text/stringUtils';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

export interface BashApprovalRequest {
  readonly command: string;
  readonly cwd?: string | null;
  readonly runId?: RunId | null;
}

/** What a bash approval settles to: the approval, or one of the refusals. */
export type BashDecision =
  Extract<RequestDecision, { action: 'approve' }> | RequestRefusal;

/**
 * Build the bash permission payload every host lists from the fold, the bash
 * counterpart of `prepareToolEditApprovalPrompt`.
 *
 * Owning it here keeps one request-id scheme, derives the bypass affordance
 * from the run's current bypass state, and drops a blank working directory
 * so no renderer has to decide what an empty `cwd` means.
 */
function prepareBashApprovalPrompt(
  request: BashApprovalRequest,
  session: SessionHandle,
): BashPermission {
  const runId = request.runId ?? undefined;
  const isBypassed = runId
    ? session.approvals.bash.bypass.isBypassed(runId)
    : false;
  const cwd = request.cwd?.trim();
  return {
    requestId: `bash-${generateShortId()}`,
    command: request.command,
    ...(cwd && { cwd }),
    allowBypass: !isBypassed,
    runId: runId ?? '',
  };
}

/**
 * Ask the person for a command: policy first (allow, deny), else a
 * `request.opened` on the run, serialized behind the run's other prompts,
 * answered by a surface's `request.decide`.
 */
export const requestBashApproval = Effect.fn('requestBashApproval')(function* (
  request: BashApprovalRequest,
): Effect.fn.Return<BashDecision, Error> {
  const approvalsEnabled = getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY);

  const context = tryUseRunContext();
  const session = currentSession();
  const runId = request.runId ?? getRunContextRunId(context);
  const isRunBypassed = Boolean(
    runId && session.approvals.bash.bypass.isBypassed(runId),
  );
  const decision = decideTexraApproval({
    policy: session.approvalPolicy,
    promptRequired: approvalsEnabled,
    scopedBypass: isRunBypassed,
    canPresent: context?.approvalPromptsUnavailable !== true,
  });

  if (decision === 'allow') return { action: 'approve' };
  if (isTexraApprovalDenied(decision)) {
    context?.onApprovalPolicyDenial?.();
    return { action: 'deny', reason: texraApprovalDenialMessage(decision) };
  }

  requireInteractions('bash approval', context);
  if (!runId) {
    return yield* Effect.fail(
      new Error('A bash approval needs a run to open its request on.'),
    );
  }

  const permission = prepareBashApprovalPrompt({ ...request, runId }, session);
  return yield* session.approvals.bash.enqueue(runId, {
    prompt: session
      .openRequest(runId, { kind: 'bash', data: permission })
      .pipe(
        Effect.map((decided): BashDecision =>
          decided.action === 'approve' ? decided : refusalOf('bash', decided),
        ),
      ),
    bypassed: Effect.succeed<BashDecision>({ action: 'approve' }),
  });
});

export function buildBashApprovalRejectedResult(
  command: string,
  refusal: RequestRefusal,
): ToolResult {
  const preview = previewLabel(command);
  const copy = refusalCopy('Command', refusal);
  const message =
    refusal.action === 'reject'
      ? `User rejected command: ${preview}`
      : `${copy.summary}: ${preview}`;
  const guidance =
    refusal.action === 'reject' ? DEFAULT_BASH_REJECTION_GUIDANCE : copy.detail;
  const feedback = copy.feedback;
  const error = feedback || !guidance ? message : `${message}\n\n${guidance}`;
  return errorResult(error, {
    summary: message,
    ...(feedback && { userInstruction: feedback }),
  });
}

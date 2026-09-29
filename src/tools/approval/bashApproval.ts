import { Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { ToolCall } from '@agent/runtime/ToolCall';
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
import { errorResult } from '@tools/core/result';
import { generateShortId } from '@utils/core';
import { readSettingFrom } from '@utils/config/platformSettings';
import { previewLabel } from '@utils/text/stringUtils';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

export interface BashApprovalRequest {
  readonly command: string;
  readonly cwd?: string | null;
  /**
   * Which standing grant answers this call. `'shell'`: a `bash` command; the
   * run's command bypass answers it, and its prompt offers approve-for-session,
   * which turns that bypass on. `'call'`: another tool's call spelled as a
   * command (an MCP tool, codex, claude_code, wolfram, send_to_terminal, a
   * setup change). The command bypass is the shell's, so it answers no such
   * call, and the prompt offers no session grant, because the one a bash
   * prompt can mint is that shell bypass. Only the run's delegated-work grant,
   * which approves everything the run does, answers it without a prompt.
   */
  readonly grant: 'shell' | 'call';
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
  runId: RunId,
  session: SessionHandle,
): BashPermission {
  const cwd = request.cwd?.trim();
  return {
    requestId: `bash-${generateShortId()}`,
    command: request.command,
    ...(cwd && { cwd }),
    allowBypass:
      request.grant === 'shell' &&
      !session.approvals.bash.bypass.isBypassed(runId),
    runId,
  };
}

/**
 * Ask the person for a command: policy first (allow, deny), else a
 * `request.opened` on the run, serialized behind the run's other prompts,
 * answered by a surface's `request.decide`.
 */
export const requestBashApproval = Effect.fn('requestBashApproval')(function* (
  request: BashApprovalRequest,
): Effect.fn.Return<BashDecision, Error, ToolCall> {
  const call = yield* ToolCall;
  const approvalsEnabled = yield* readSettingFrom<boolean>(
    call.roots,
    BASH_APPROVAL_CONFIG_KEY,
  );
  const run = call.run;
  if (!run) {
    return yield* Effect.fail(
      new Error('A bash approval needs an active run.'),
    );
  }
  const { session, runId } = run;
  const granted = () =>
    (request.grant === 'shell'
      ? session.approvals.bash.bypass
      : session.approvals.proposal
    ).isBypassed(runId);
  const decision = decideTexraApproval({
    policy: session.approvalPolicy,
    promptRequired: approvalsEnabled,
    scopedBypass: granted(),
    canPresent: run.toolPolicy.approvalPromptsUnavailable !== true,
  });

  if (decision === 'allow') return { action: 'approve' };
  if (isTexraApprovalDenied(decision)) {
    session.interactions.approvalDenied({ kind: 'executable' }, runId);
    return { action: 'deny', reason: texraApprovalDenialMessage(decision) };
  }

  const permission = prepareBashApprovalPrompt(request, runId, session);
  const prompt = session
    .openRequest(runId, { kind: 'bash', data: permission })
    .pipe(
      Effect.map((decided): BashDecision =>
        decided.action === 'approve' ? decided : refusalOf('bash', decided),
      ),
    );
  const approved = Effect.succeed<BashDecision>({ action: 'approve' });
  // The queue re-reads the shell's bypass when a call reaches the head of the
  // run's lane. Another tool's call re-reads its own grant there instead, so a
  // command bypass turned on while it waited does not answer it.
  const atDispatch = Effect.suspend(() => (granted() ? approved : prompt));
  return yield* session.approvals.bash.enqueue(
    runId,
    request.grant === 'shell'
      ? { prompt, bypassed: approved }
      : { prompt: atDispatch, bypassed: atDispatch },
  );
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

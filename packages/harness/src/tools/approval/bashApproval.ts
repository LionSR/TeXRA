import { Effect } from 'effect';

import { requireRun, sessionOf } from '@agent/runtime/RunCall';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  type DecisionOf,
  type RefusalDecision,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@shared/session/approvalDecision';
import { errorResult } from '@tools/core/result';
import { previewLabel } from '@utils/text/stringUtils';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

export interface BashApprovalRequest {
  readonly command: string;
  readonly cwd?: string | null;
  /**
   * The standing grant that answers this call while it waits: `'bash'`, the
   * run's command grant, which its prompt offers to turn on; `'call'`, only
   * the run's delegated-work grant (no session grant is offered); `null`, a
   * `PreToolUse` hook asked, so only a person answers.
   */
  readonly grant: 'bash' | 'call' | null;
}

/**
 * Ask the person about a call that `sessionPermission` (`loop/toolGuard.ts`)
 * said to ask about: a `request.opened` on the run, serialized behind the
 * run's other prompts, answered by a surface's `request.decide`.
 */
export const requestBashApproval = Effect.fn('requestBashApproval')(function* (
  request: BashApprovalRequest,
): Effect.fn.Return<DecisionOf<'bash'>, Error, ToolContext> {
  const { run, requests } = yield* requireRun('A bash approval');
  const { runId } = run;
  const session = sessionOf(run);
  const granted = () =>
    request.grant !== null &&
    session.approvals.bypass(
      runId,
      request.grant === 'bash' ? 'bash' : 'superYolo',
    ) !== null;

  // The payload every host lists: a blank directory is dropped, so no
  // renderer decides what an empty `cwd` means.
  const cwd = request.cwd?.trim();
  const prompt = requests
    .open({
      kind: 'bash',
      data: {
        requestId: requests.nextId('bash'),
        command: request.command,
        ...(cwd && { cwd }),
        allowBypass: request.grant === 'bash' && !granted(),
        runId,
      },
    })
    .pipe(Effect.map(({ decision }) => decision));
  // The call's own grant is read again when it reaches the head of the
  // run's lane, so a command grant turned on while another tool's call
  // waited does not answer it.
  const atDispatch = Effect.suspend(() =>
    granted()
      ? Effect.succeed<DecisionOf<'bash'>>({ action: 'approve' })
      : prompt,
  );
  return yield* session.approvals.enqueue('bash', runId, {
    prompt: atDispatch,
    bypassed: atDispatch,
  });
});

export function buildBashApprovalRejectedResult(
  command: string,
  refusal: RefusalDecision,
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

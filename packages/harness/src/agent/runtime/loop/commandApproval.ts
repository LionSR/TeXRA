/**
 * The ask the guard (`toolGuard.ts`) opens when `sessionPermission` said to
 * ask about a call it shows as a command, and the result a refusal leaves.
 */
import { Effect } from 'effect';

import type { CallRequests } from '@agent/core/tools/ToolTypes';
import type {
  DecisionOf,
  RefusalDecision,
  RunId,
  ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@shared/session/approvalDecision';
import type { ApprovalOperation } from '@shared/session/sessionApprovals';
import { errorResult } from '@tools/core/result';
import { previewLabel } from '@utils/text/stringUtils';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

/**
 * Ask the person about `command`: a `request.opened` on the run, answered
 * by a surface's `request.decide`, or by the grant that answers it turned
 * on meanwhile, which answers every open request it covers. `operation`
 * says which grant that is: the shell's command grant (`'bash'`), or, for
 * another tool's call, the delegated-work grant; a `PreToolUse` hook that
 * asked leaves it to a person.
 */
export const askCommandApproval = Effect.fn('askCommandApproval')(function* (
  runId: RunId,
  requests: CallRequests,
  ask: {
    readonly command: string;
    readonly cwd: string | undefined;
    readonly operation: Extract<ApprovalOperation, 'bash' | 'call'>;
  },
): Effect.fn.Return<DecisionOf<'bash'>, Error> {
  // The payload every host lists: a blank directory is dropped, so no
  // renderer decides what an empty `cwd` means.
  const cwd = ask.cwd?.trim();
  const { decision } = yield* requests.open(
    {
      kind: 'bash',
      data: {
        requestId: requests.nextId('bash'),
        command: ask.command,
        ...(cwd && { cwd }),
        runId,
      },
    },
    { operation: ask.operation },
  );
  return decision;
});

/** What the model is told when the person refuses `command`. */
export function commandRejectedResult(
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

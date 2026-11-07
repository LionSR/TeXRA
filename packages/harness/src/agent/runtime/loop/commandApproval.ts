/**
 * The ask the guard (`toolGuard.ts`) opens when `sessionPermission` said to
 * ask about a call it shows as a command, and the result a refusal leaves.
 */
import { Effect } from 'effect';

import type { CallRequests } from '@agent/core/tools/ToolTypes';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type {
  DecisionOf,
  RefusalDecision,
  RunId,
  ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@shared/session/approvalDecision';
import { errorResult } from '@tools/core/result';
import { previewLabel } from '@utils/text/stringUtils';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

/**
 * Ask the person about `command`: a `request.opened` on the run, answered
 * by a surface's `request.decide`, or by the command grant turned on
 * meanwhile, which answers every open request it covers. `grant` is the
 * grant the prompt may offer to turn on: `'bash'`, the run's command grant;
 * `'superYolo'`, the delegated-work grant, which it does not offer; `null`,
 * a `PreToolUse` hook asked, so only a person answers.
 */
export const askCommandApproval = Effect.fn('askCommandApproval')(function* (
  runId: RunId,
  requests: CallRequests,
  ask: {
    readonly command: string;
    readonly cwd: string | undefined;
    readonly grant: ApprovalBypassKind | null;
  },
): Effect.fn.Return<DecisionOf<'bash'>, Error> {
  // The payload every host lists: a blank directory is dropped, so no
  // renderer decides what an empty `cwd` means.
  const cwd = ask.cwd?.trim();
  const { decision } = yield* requests.open({
    kind: 'bash',
    data: {
      requestId: requests.nextId('bash'),
      command: ask.command,
      ...(cwd && { cwd }),
      // The policy asked, so the command grant is off.
      offersGrant: ask.grant === 'bash',
      runId,
    },
  });
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

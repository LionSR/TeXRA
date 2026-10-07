import { Effect } from 'effect';

import { type RunId } from '@texra-ai/harness/schemas';
import {
  appendLocalNotice,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import type { SessionRequests } from '@cli/chat/tui/state/approvalQueue';
import {
  formatTexraApprovalPolicy,
  parseTexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { RUN_GRANT_NOUN } from '@ui/copy/delegationApproval';

import { type SlashCommandContext } from './slashContext';

const APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';

/**
 * `/approval` sets the chat's policy. A chat running in this process takes
 * it as a session override, like `--approval-policy`. A chat whose tasks run
 * in the service writes the project's persisted policy instead: the service
 * follows only that setting, for every window and terminal of the project.
 */
export function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
): void {
  const normalized = input.trim().toLowerCase();
  const policy = parseTexraApprovalPolicy(normalized);
  if (!policy) {
    setTransientNotice(APPROVAL_USAGE);
    return;
  }

  context.setApprovalPolicy(policy);
  appendLocalNotice(`Approval mode: ${formatTexraApprovalPolicy(policy)}`);
}

/**
 * `/approval`'s revoke: the same `policy.set` mutation the approval card's
 * `a` key grants with, cleared, so the run's `approval.policy` row (and the
 * status-bar badge) is the confirmation.
 */
export function revokeCliRunGrant(
  requests: SessionRequests,
  runId: RunId,
  bypass: ApprovalBypassKind,
): Effect.Effect<void> {
  return requests
    .request({
      kind: 'policy.set',
      change: { field: 'bypass', runId, bypass, enabled: false },
    })
    .pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, runId),
        onSuccess: () =>
          appendLocalNotice(`Auto-approving ${RUN_GRANT_NOUN[bypass]}: off`),
      }),
    );
}

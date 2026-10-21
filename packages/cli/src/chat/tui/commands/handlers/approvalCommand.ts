import { Effect } from 'effect';

import { type RunId, parseApprovalPolicy } from '@texra-ai/harness/schemas';
import {
  appendLocalNotice,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import type { SessionRequests } from '@cli/chat/tui/state/approvalQueue';
import { formatApprovalPolicy } from '@ui/copy/approvalPolicy';
import { RUN_GRANT_NOUN } from '@ui/copy/delegationApproval';
import { type SlashCommandContext } from './slashContext';
import type { ApprovalBypassKind } from '@texra-ai/harness/schemas';

const APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';

/**
 * `/approval` sets this chat's launch policy, like `--approval-policy`, here
 * or in the service; it never writes the project's policy, which `/config`
 * and the settings view change.
 */
export function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
): Effect.Effect<void> {
  const policy = parseApprovalPolicy(input.trim().toLowerCase());
  if (!policy) return Effect.sync(() => setTransientNotice(APPROVAL_USAGE));
  const confirm = `Approval mode: ${formatApprovalPolicy(policy)}`;
  return context
    .setApprovalPolicy(policy)
    .pipe(Effect.andThen(Effect.sync(() => appendLocalNotice(confirm))));
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

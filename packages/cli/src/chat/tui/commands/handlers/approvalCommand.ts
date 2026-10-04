import { Effect } from 'effect';

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
import { type RunId } from '@shared/schemas';
import { RUN_GRANT_NOUN } from '@ui/copy/delegationApproval';

import { type SlashCommandContext } from './slashContext';

const APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';

/**
 * `/approval` is a session-scoped override, like `--approval-policy`: it moves
 * the live policy for this session only and never writes `.texra/config.json`.
 * The persisted default is `/config`'s row, which applies its new value to this
 * same session through the shared write path's approval-policy port.
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

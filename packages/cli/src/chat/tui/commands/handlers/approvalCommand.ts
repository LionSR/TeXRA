import { Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime';
import {
  appendLocalAssistantTranscript,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { APPROVAL_BYPASS_LABEL } from '@cli/chat/tui/forms/ApprovalPolicyForm';
import {
  formatTexraApprovalPolicy,
  parseTexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';

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
    appendLocalAssistantTranscript(APPROVAL_USAGE);
    return;
  }

  context.setApprovalPolicy(policy);
  appendLocalAssistantTranscript(
    `Approval mode: ${formatTexraApprovalPolicy(policy)}`,
  );
}

/**
 * `/approval`'s session toggles: the same `policy.set` mutation the approval
 * card's "approve for session" key and the extension toolbar send, so the
 * run's `approval.policy` row (and the status-bar badge) is the confirmation.
 */
export function setCliRunBypass(
  session: SessionHandle,
  runId: RunId,
  bypass: keyof typeof APPROVAL_BYPASS_LABEL,
  enabled: boolean,
): Effect.Effect<void> {
  return session.requests
    .request({
      kind: 'policy.set',
      change: { field: 'bypass', runId, bypass, enabled },
    })
    .pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, runId),
        onSuccess: () =>
          appendLocalAssistantTranscript(
            `${APPROVAL_BYPASS_LABEL[bypass]}: ${enabled ? 'on' : 'off'}`,
          ),
      }),
    );
}

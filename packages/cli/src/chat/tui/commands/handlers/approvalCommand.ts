import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import {
  formatTexraApprovalPolicy,
  parseTexraApprovalPolicy,
} from '@shared/approvalPolicy';

import { openCliSlashCommandForm } from '../slashForms';
import { type SlashCommandContext } from './slashContext';

const APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';
export const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

/**
 * `/approval` is a session-scoped override, like `--approval-policy`: it moves
 * the live policy for this session only and never writes `.texra/config.json`.
 * The persisted default is `/config`'s row, which applies its new value to this
 * same session through the shared write path's approval-policy port.
 */
export function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
  usage: string = APPROVAL_USAGE,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    openCliSlashCommandForm('approval', '');
    return;
  }

  const policy = parseTexraApprovalPolicy(normalized);
  if (!policy) {
    appendLocalAssistantTranscript(usage);
    return;
  }

  context.setApprovalPolicy(policy);
  appendLocalAssistantTranscript(
    `Approval mode: ${formatTexraApprovalPolicy(policy)}`,
  );
}

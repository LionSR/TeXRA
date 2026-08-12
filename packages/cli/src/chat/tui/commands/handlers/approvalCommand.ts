import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import {
  formatTexraApprovalPolicy,
  parseTexraApprovalPolicy,
} from '@shared/approvalPolicy';

import { openCliSlashCommandForm } from '../slashForms';
import { type SlashCommandContext } from './slashContext';

export const APPROVAL_USAGE = 'Usage: /approval [ask | never | yolo]';
export const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

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

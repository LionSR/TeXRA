import {
  formatCliApprovalPolicy,
  parseCliApprovalPolicy,
} from '@cli/runtime/approvalPolicyText';

import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { openCliSlashCommandForm } from '../slashForms';
import { type SlashCommandContext } from './slashContext';

const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

export function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
  usage = YOLO_USAGE,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    openCliSlashCommandForm('approval', '');
    return;
  }

  const policy = parseCliApprovalPolicy(normalized);
  if (!policy) {
    appendLocalAssistantTranscript(usage);
    return;
  }

  context.setApprovalPolicy(policy);
  appendLocalAssistantTranscript(
    `Approval mode set to ${formatCliApprovalPolicy(policy)}.`,
  );
}

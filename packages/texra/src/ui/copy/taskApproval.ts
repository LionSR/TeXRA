/**
 * The composer's per-task approval choice, in the approval policy's own
 * words (`@shared/approvalPolicy`): a task follows the policy, or is
 * auto-approved on its own. It can only loosen Ask; Block still blocks,
 * and the run header keeps the switch in view so the user can take the
 * choice back mid-run.
 */
import { texraApprovalPolicyLabel } from '@shared/approvalPolicy';

const AUTO_APPROVE_LABEL = texraApprovalPolicyLabel('yolo');

export const TASK_APPROVAL = {
  title: 'Approval',
  policy: {
    label: 'Approval policy',
    detail: 'as set in Settings',
    description:
      'Ask, Block or Auto-approve, as your approval policy in Settings says.',
  },
  autoApprove: {
    label: AUTO_APPROVE_LABEL,
    detail: 'this task only',
    description:
      'Auto-approve file edits, shell commands and agent work in this task. Turn it off from the task header at any time; a Block policy still blocks.',
  },
} as const;

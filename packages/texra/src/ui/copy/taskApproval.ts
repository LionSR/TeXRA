/**
 * The composer's per-task approval choice, in the approval policy's own
 * words (`@shared/approvalPolicy`): a task follows the policy, or is
 * auto-approved on its own. It can only loosen Ask; Block still blocks,
 * and the run header keeps the switch in view so the user can take the
 * choice back mid-run.
 */
import { approvalPolicyLabel } from '@ui/copy/approvalPolicy';

const AUTO_APPROVE_LABEL = approvalPolicyLabel('yolo');

export const TASK_APPROVAL = Object.freeze({
  title: 'Approval',
  autoApprove: Object.freeze({
    label: AUTO_APPROVE_LABEL,
    /** The menu's row for the choice, and its line under a Block policy. */
    menuLabel: 'Auto-approve this task',
    menuDescription:
      'Allow file edits, commands and agent work without asking.',
    blocked: 'Blocked by your approval settings.',
    description:
      'Auto-approve file edits, shell commands and agent work in this task. Turn it off from the task header at any time; a Block policy still blocks.',
  }),
} as const);

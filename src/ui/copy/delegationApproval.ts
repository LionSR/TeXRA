import type { ApprovalBypassKind } from '@shared/approvalBypassKind';

/**
 * The run-scoped grant each approval kind's Approve ▾ menu offers, one noun
 * per kind: edits, commands, agent work. The run toolbar names the same grant
 * with the same noun.
 */
export const RUN_GRANT_LABEL = Object.freeze({
  toolEdit: 'Approve all edits in this run',
  bash: 'Approve all commands in this run',
  superYolo: 'Approve all agent work in this run',
} as const satisfies Record<ApprovalBypassKind, string>);

/** Host-specific user copy for the delegated-work approval grant. */
export const DELEGATION_APPROVAL_COPY = Object.freeze({
  cliAction: 'approve agent work for this chat',
  cliCompactAction: 'all agent work',
  cliExplanation:
    'Press y to approve only this task. Press a to approve delegated tasks, file edits, and commands for this chat. Other prompts still ask.',
  progressViewToggle:
    'Auto-approve later agent tasks, file edits, and shell commands in this run',
} as const);

/**
 * Host-specific user copy for the plan "Run as Goal" grant. Commands-only is
 * the shared default; the CLI may explicitly broaden one goal to commands,
 * edits, and delegated work. `progressViewExplanation` is the clause that
 * follows the bolded action name in the panel, so it opens mid-sentence.
 */
export const PLAN_GOAL_COPY = Object.freeze({
  action: 'Run as Goal',
  progressViewExplanation:
    'keeps the agent working across turns until it completes the plan, needs your input, or you stop it. Only Bash commands are auto-approved; edits and other actions still ask.',
  cliNotice: 'Runs until done; only Bash is automatic.',
  cliAutoApproveAllNotice:
    'Runs until done; commands, edits, and agent work are automatic.',
} as const);

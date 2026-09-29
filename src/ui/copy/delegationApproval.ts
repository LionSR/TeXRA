import type { ApprovalBypassKind } from '@shared/approvalBypassKind';

/**
 * What each run-scoped grant approves, one noun per approval kind: edits,
 * commands, agent work. The approval cards' Approve ▾ menu and the run
 * header's auto-approve switches name the same grant with the same noun.
 */
export const RUN_GRANT_NOUN = Object.freeze({
  toolEdit: 'edits',
  bash: 'commands',
  superYolo: 'agent work',
} as const satisfies Record<ApprovalBypassKind, string>);

/** The approval card's run-grant item, e.g. "Approve all edits in this run". */
export const RUN_GRANT_LABEL = Object.freeze({
  toolEdit: `Approve all ${RUN_GRANT_NOUN.toolEdit} in this run`,
  bash: `Approve all ${RUN_GRANT_NOUN.bash} in this run`,
  superYolo: `Approve all ${RUN_GRANT_NOUN.superYolo} in this run`,
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

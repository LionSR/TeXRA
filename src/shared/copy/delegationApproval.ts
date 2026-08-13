/** Host-specific user copy for the delegated-work approval grant. */
export const DELEGATION_APPROVAL_COPY = Object.freeze({
  cliAction: 'approve agent work for this chat',
  cliCompactAction: 'all agent work',
  cliExplanation:
    'Press y to approve only this task. Press a to approve delegated tasks, file edits, and commands for this chat. Other prompts still ask.',
  progressViewAction: 'Approve agent work for this run',
  progressViewExplanation:
    'Approves this request, queued and later agent tasks, and queued and later file edits and shell commands in this run. Plans, retries, external inquiries, and user questions still require a decision.',
  progressViewToggle:
    'Auto-approve later agent tasks, file edits, and shell commands in this run',
  progressViewEditAction:
    'Approve and later auto-approve file edits in this run',
  progressViewCommandAction:
    'Approve and later auto-approve shell commands in this run',
} as const);

/**
 * Host-specific user copy for the plan "Run as Goal" grant. Both hosts state
 * the same rule, owned by `goalAutoApproval.ts`: a goal run auto-approves Bash
 * and nothing else. `progressViewExplanation` is the clause that follows the
 * bolded action name in the panel, so it opens mid-sentence.
 */
export const PLAN_GOAL_COPY = Object.freeze({
  action: 'Run as Goal',
  progressViewExplanation:
    'keeps the agent working across turns until it completes the plan, needs your input, or you stop it. Only Bash commands are auto-approved; edits and other actions still ask.',
  cliNotice: 'Runs until done; only Bash is automatic.',
} as const);

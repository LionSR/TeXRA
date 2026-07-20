/** Host-specific user copy for the delegated-work approval grant. */
export const DELEGATION_APPROVAL_COPY = Object.freeze({
  cliAction: 'approve agent work for this chat',
  cliCompactAction: 'agent work in this chat',
  cliExplanation:
    'Approves this task and later tasks from this agent, plus file edits and commands. Other prompts still ask.',
  progressViewAction: 'Approve agent work for this run',
  progressViewExplanation:
    'Approves this request, queued and later agent tasks requested by this agent, and queued and later file edits and shell commands in this run. Plans, retries, external inquiries, and user questions still require a decision.',
  progressViewToggle:
    'Auto-approve later agent tasks requested by this agent, plus later file edits and shell commands in this run',
  progressViewEditCommandAction:
    'Approve and later auto-approve file edits and shell commands in this run',
} as const);

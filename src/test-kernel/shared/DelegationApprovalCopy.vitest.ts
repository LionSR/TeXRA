import { describe, expect, it } from 'vitest';

import {
  DELEGATION_APPROVAL_COPY,
  PLAN_GOAL_COPY,
} from '@shared/copy/delegationApproval';

describe('delegated-work approval copy', () => {
  it('freezes the host-specific lifetime and scope wording', () => {
    expect(Object.isFrozen(DELEGATION_APPROVAL_COPY)).toBe(true);
    expect(DELEGATION_APPROVAL_COPY).toEqual({
      cliAction: 'approve agent work for this chat',
      cliCompactAction: 'all agent work',
      cliExplanation:
        'Approves this task and later tasks from this agent, plus file edits and commands. Other prompts still ask.',
      progressViewAction: 'Approve agent work for this run',
      progressViewExplanation:
        'Approves this request, queued and later agent tasks requested by this agent, and queued and later file edits and shell commands in this run. Plans, retries, external inquiries, and user questions still require a decision.',
      progressViewToggle:
        'Auto-approve later agent tasks requested by this agent, plus later file edits and shell commands in this run',
      progressViewEditAction:
        'Approve and later auto-approve file edits in this run',
      progressViewCommandAction:
        'Approve and later auto-approve shell commands in this run',
    });
  });
});

describe('plan goal copy', () => {
  it('freezes the Bash-only auto-approval wording both hosts state', () => {
    expect(Object.isFrozen(PLAN_GOAL_COPY)).toBe(true);
    expect(PLAN_GOAL_COPY).toEqual({
      action: 'Run as Goal',
      progressViewExplanation:
        'keeps the agent working across turns until it completes the plan, needs your input, or you stop it. Only Bash commands are auto-approved; edits and other actions still ask.',
      cliNotice: 'Runs until done; only Bash is automatic.',
    });
  });
});

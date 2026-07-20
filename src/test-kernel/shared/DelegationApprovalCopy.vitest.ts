import { describe, expect, it } from 'vitest';

import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

describe('delegated-work approval copy', () => {
  it('freezes the host-specific lifetime and scope wording', () => {
    expect(Object.isFrozen(DELEGATION_APPROVAL_COPY)).toBe(true);
    expect(DELEGATION_APPROVAL_COPY).toEqual({
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
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  formatCliSessionStatus,
  type CliSessionStatusInput,
} from '@cli/chat/tui/sessionStatus';

function sessionStatus(overrides: Partial<CliSessionStatusInput> = {}): string {
  return formatCliSessionStatus({
    agent: 'chat',
    model: 'harness-model',
    modelAccess: 'api-key',
    approvalPolicy: 'ask',
    statusLabel: 'Running',
    activeSkills: [],
    queuedFollowUpMessages: [],
    ...overrides,
  });
}

describe('CLI session status formatter', () => {
  it('keeps multiline queued follow-ups readable as one-line summaries', () => {
    const status = sessionStatus({
      queuedFollowUpMessages: [
        [
          'Please inspect the generated diff.',
          'Then report whether the queued edits should still run.',
        ].join('\n'),
      ],
    });

    expect(status).toContain(
      '1. Please inspect the generated diff. Then report whether the queued edits should still run.',
    );
  });

  it('reports active session approval bypasses', () => {
    const status = sessionStatus({
      approvalBypasses: { superYolo: true, bash: true, toolEdit: true },
      statusLabel: 'Idle',
    });

    expect(status).toContain(
      'auto-approvals: delegated tasks, commands, file edits',
    );
    expect(status).not.toContain('all privileged actions');
  });
});

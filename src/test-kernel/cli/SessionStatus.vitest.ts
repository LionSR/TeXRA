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

  it('surfaces the session id and resume command once a run has started', () => {
    const status = sessionStatus({
      sessionId: 'abc123',
    });

    expect(status).toContain('session: abc123');
    expect(status).toContain('resume later with: texra resume abc123');
  });

  it('omits session lines before the first run starts', () => {
    const status = sessionStatus({
      statusLabel: undefined,
    });

    expect(status).not.toContain('session:');
    expect(status).not.toContain('resume later with:');
  });

  it('reports active child sessions only when the count is nonzero', () => {
    expect(sessionStatus({ activeChildSessions: 1 })).toContain(
      ['status: Running', 'active background tasks: 1'].join('\n'),
    );
    expect(sessionStatus({ activeChildSessions: 0 })).not.toContain(
      'active background tasks:',
    );
    expect(sessionStatus()).not.toContain('active background tasks:');
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

  it('surfaces an active goal in status details', () => {
    const status = sessionStatus({
      modelAccess: 'api-key',
      statusLabel: 'Stopped',
      goal: {
        status: 'active',
        objective:
          'Solve the autonomous goal problem and produce a verifier before stopping.',
      },
      sessionId: 'goal123',
    });

    expect(status).toContain('status: Stopped');
    expect(status).toContain('goal: active');
    expect(status).toContain(
      'goal objective: Solve the autonomous goal problem and produce a verifier before stopping.',
    );
  });

  it('reports ChatGPT as the selected model access', () => {
    const status = sessionStatus({
      model: 'gpt56-',
      modelAccess: 'chatgpt-subscription',
    });

    expect(status).toContain('model: GPT-5.6 Terra');
    expect(status).toContain(
      [
        'model access: ChatGPT subscription',
        'approval: Control Bash and edit prompts independently.',
      ].join('\n'),
    );
  });

  it('includes team identity when a chat was launched from a preset', () => {
    expect(
      sessionStatus({
        agent: 'orchestrator',
        teamName: 'Physicist',
      }),
    ).toContain(['team: Physicist', 'agent: orchestrator'].join('\n'));
  });
});

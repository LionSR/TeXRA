import { describe, expect, it } from 'vitest';

import {
  formatCliStatusLabel,
  formatCliSessionStatus,
  type CliSessionStatusInput,
} from '@cli/chat/tui/sessionStatus';
import { STREAM_PHASE } from '@shared/schemas';

function sessionStatus(overrides: Partial<CliSessionStatusInput> = {}): string {
  return formatCliSessionStatus({
    agent: 'chat',
    model: 'harness-model',
    modelAccess: 'personal',
    approval: 'ask',
    status: 'running',
    queuedFollowUpMessages: [],
    ...overrides,
  });
}

describe('CLI session status formatter', () => {
  it('lists queued follow-up messages in the details output', () => {
    expect(
      sessionStatus({
        queuedFollowUpMessages: [
          'First queued follow-up is to re-run the narrow layout proof check.',
          'Second queued message asks for the theorem statement cleanup.',
        ],
      }),
    ).toBe(
      [
        'agent: chat',
        'model: harness-model',
        'model access: Your own API keys',
        'approval: ask',
        'status: running',
        'queued follow-ups: 2',
        '1. First queued follow-up is to re-run the narrow layout proof check.',
        '2. Second queued message asks for the theorem statement cleanup.',
      ].join('\n'),
    );
  });

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

  it('summarizes queued subagent follow-up payloads', () => {
    const status = sessionStatus({
      queuedFollowUpMessages: [
        '<orchestrator-followup><subagent-result id="child-q" agent="reviewer" category="toolUse" status="completed"><response>All good &lt;ok&gt;</response></subagent-result></orchestrator-followup>',
      ],
    });

    expect(status).toContain('1. ✓ reviewer completed All good <ok>');
    expect(status).not.toContain('<orchestrator-followup>');
    expect(status).not.toContain('<subagent-result');
  });

  it('keeps malformed queued follow-up entries from breaking status details', () => {
    const status = sessionStatus({
      queuedFollowUpMessages: [undefined as unknown as string],
    });

    expect(status).toContain('queued follow-ups: 1');
    expect(status).toContain('1. (empty follow-up)');
  });

  it('surfaces the session id and resume command once a run has started', () => {
    const status = sessionStatus({
      sessionId: 'abc123',
    });

    expect(status).toContain('session: abc123');
    expect(status).toContain('resume later with: texra resume abc123');
  });

  it.each([
    {
      name: 'uses the provided command name',
      overrides: { commandName: 'texra-local' },
      expected: 'resume later with: texra-local resume abc123',
    },
    {
      name: 'includes cwd when the session uses another workspace',
      overrides: {
        commandName: 'texra-local',
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
      },
      expected: 'resume later with: texra-local resume abc123 --cwd /tmp/paper',
    },
    {
      name: 'includes the active non-default approval policy',
      overrides: {
        approval: 'deny privileged actions',
        approvalPolicy: 'never' as const,
        status: 'waiting' as const,
        commandName: 'texra-local',
      },
      expected:
        'resume later with: texra-local resume abc123 --approval-policy never',
    },
    {
      name: 'includes cwd and approval policy when both apply',
      overrides: {
        approval: 'deny privileged actions',
        approvalPolicy: 'never' as const,
        status: 'waiting' as const,
        commandName: 'texra-local',
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
      },
      expected:
        'resume later with: texra-local resume abc123 --cwd /tmp/paper --approval-policy never',
    },
  ])('resume status line $name', ({ overrides, expected }) => {
    const status = sessionStatus({ sessionId: 'abc123', ...overrides });

    expect(status).toContain(expected);
  });

  it('omits session lines before the first run starts', () => {
    const status = sessionStatus({
      status: 'not started',
    });

    expect(status).not.toContain('session:');
    expect(status).not.toContain('resume later with:');
  });

  it('reports an empty follow-up queue explicitly', () => {
    expect(
      sessionStatus({
        status: 'waiting',
      }),
    ).toContain('queued follow-ups: 0');
  });

  it('reports active child sessions only when the count is nonzero', () => {
    expect(sessionStatus({ activeChildSessions: 1 })).toContain(
      ['status: running', 'active child sessions: 1'].join('\n'),
    );
    expect(sessionStatus({ activeChildSessions: 0 })).not.toContain(
      'active child sessions:',
    );
    expect(sessionStatus()).not.toContain('active child sessions:');
  });

  it('reports active session approval bypasses', () => {
    const status = sessionStatus({
      approval: 'ask before privileged actions',
      approvalBypasses: { superYolo: true, bash: true, toolEdit: true },
      status: 'waiting',
    });

    expect(status).toContain(
      'auto-approvals: delegated tasks, commands, file edits',
    );
    expect(status).not.toContain('all privileged actions');
  });

  it('surfaces an active goal in status details', () => {
    const status = sessionStatus({
      modelAccess: 'included',
      approval: 'ask before privileged actions',
      status: 'stopped',
      goal: {
        status: 'active',
        objective:
          'Solve the autonomous goal problem and produce a verifier before stopping.',
      },
      sessionId: 'goal123',
    });

    expect(status).toContain('status: stopped');
    expect(status).toContain('goal: active');
    expect(status).toContain(
      'goal objective: Solve the autonomous goal problem and produce a verifier before stopping.',
    );
  });

  it('reports ChatGPT as the selected model access', () => {
    const status = sessionStatus({
      model: 'gpt55',
      modelAccess: 'chatgpt',
    });

    expect(status).toContain(
      ['model access: ChatGPT subscription', 'approval: ask'].join('\n'),
    );
  });

  it('reports included TeXRA model access without a subscription line', () => {
    const status = sessionStatus({
      model: 'gpt55',
      modelAccess: 'included',
    });

    expect(status).toContain('model access: Included access');
    expect(status).not.toContain('subscription:');
  });

  it('includes team identity when a chat was launched from a preset', () => {
    expect(
      sessionStatus({
        agent: 'orchestrator',
        teamName: 'Physicist',
      }),
    ).toContain(['team: Physicist', 'agent: orchestrator'].join('\n'));
  });

  it('uses the footer label for an idle waiting stream', () => {
    expect(formatCliStatusLabel(STREAM_PHASE.WAITING)).toBe('idle');
    expect(formatCliStatusLabel(undefined, undefined, true)).toBe('');
    expect(formatCliStatusLabel('stopped', undefined, true)).toBe('stopped');
    expect(
      sessionStatus({
        agent: 'research',
        model: 'deepseekT',
        modelAccess: 'included',
        approval: 'ask before privileged actions',
        status: STREAM_PHASE.WAITING,
      }),
    ).toContain('status: idle');
  });

  it('uses the idle wording for a subagent stalled on follow-up', () => {
    expect(formatCliStatusLabel(STREAM_PHASE.WAITING, undefined, true)).toBe(
      'idle',
    );
  });

  it('keeps a single lowercase register across child-stream status labels', () => {
    expect(formatCliStatusLabel(STREAM_PHASE.RUNNING, undefined, true)).toBe(
      'running',
    );
    expect(formatCliStatusLabel(STREAM_PHASE.CANCELLED, undefined, true)).toBe(
      'stopped',
    );
    expect(formatCliStatusLabel(STREAM_PHASE.FAILED, undefined, true)).toBe(
      'error',
    );
  });
});

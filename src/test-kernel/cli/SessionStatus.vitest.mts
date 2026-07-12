import { describe, expect, it } from 'vitest';

import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  formatCliStatusLabel,
  formatCliSessionStatus,
} from '@cli/chat/tui/sessionStatus';
import { STREAM_PHASE } from '@shared/schemas';

const STREAM_ID = 'status-queued-followups-test-stream';

describe('CLI session status formatter', () => {
  it('lists queued follow-up messages in the details output', () => {
    expect(
      formatCliSessionStatus({
        agent: 'chat',
        model: 'harness-model',
        api: 'personal',
        approval: 'ask',
        status: 'running',
        queuedFollowUpMessages: [
          'First queued follow-up is to re-run the narrow layout proof check.',
          'Second queued message asks for the theorem statement cleanup.',
        ],
      }),
    ).toBe(
      [
        'agent: chat',
        'model: harness-model',
        'api: personal',
        'approval: ask',
        'status: running',
        'queued follow-ups: 2',
        '1. First queued follow-up is to re-run the narrow layout proof check.',
        '2. Second queued message asks for the theorem statement cleanup.',
      ].join('\n'),
    );
  });

  it('keeps multiline queued follow-ups readable as one-line summaries', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'running',
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
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'running',
      queuedFollowUpMessages: [
        '<orchestrator-followup><subagent-result id="child-q" agent="reviewer" category="toolUse" status="completed"><response>All good &lt;ok&gt;</response></subagent-result></orchestrator-followup>',
      ],
    });

    expect(status).toContain('1. ✓ reviewer completed All good <ok>');
    expect(status).not.toContain('<orchestrator-followup>');
    expect(status).not.toContain('<subagent-result');
  });

  it('keeps malformed queued follow-up entries from breaking status details', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'running',
      queuedFollowUpMessages: [undefined as unknown as string],
    });

    expect(status).toContain('queued follow-ups: 1');
    expect(status).toContain('1. (empty follow-up)');
  });

  it('surfaces the session id and resume command once a run has started', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'running',
      sessionId: 'abc123',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain('session: abc123');
    expect(status).toContain('resume later with: texra resume abc123');
  });

  it('uses the provided command name in the resume status line', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'running',
      sessionId: 'abc123',
      commandName: 'texra-local',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain('resume later with: texra-local resume abc123');
  });

  it('includes cwd in the resume status line when the session uses another workspace', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'running',
      sessionId: 'abc123',
      commandName: 'texra-local',
      cwd: '/tmp/paper',
      processCwd: '/tmp/launcher',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain(
      'resume later with: texra-local resume abc123 --cwd /tmp/paper',
    );
  });

  it('includes the active non-default approval policy in the resume status line', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'deny privileged actions',
      approvalPolicy: 'never',
      status: 'waiting',
      sessionId: 'abc123',
      commandName: 'texra-local',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain(
      'resume later with: texra-local resume abc123 --approval-policy never',
    );
  });

  it('includes cwd and approval policy when both affect the resume status line', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'deny privileged actions',
      approvalPolicy: 'never',
      status: 'waiting',
      sessionId: 'abc123',
      commandName: 'texra-local',
      cwd: '/tmp/paper',
      processCwd: '/tmp/launcher',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain(
      'resume later with: texra-local resume abc123 --cwd /tmp/paper --approval-policy never',
    );
  });

  it('omits session lines before the first run starts', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask',
      status: 'not started',
      queuedFollowUpMessages: [],
    });

    expect(status).not.toContain('session:');
    expect(status).not.toContain('resume later with:');
  });

  it('reports an empty follow-up queue explicitly', () => {
    expect(
      formatCliSessionStatus({
        agent: 'chat',
        model: 'harness-model',
        api: 'personal',
        approval: 'ask',
        status: 'waiting',
        queuedFollowUpMessages: [],
      }),
    ).toContain('queued follow-ups: 0');
  });

  it('reports active session approval bypasses', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'personal',
      approval: 'ask before privileged actions',
      approvalBypasses: { superYolo: true, bash: true, toolEdit: true },
      status: 'waiting',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain(
      'auto-approvals: delegated tasks, commands, file edits',
    );
    expect(status).not.toContain('all privileged actions');
  });

  it('surfaces an active goal in status details', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'harness-model',
      api: 'included TeXRA access',
      approval: 'ask before privileged actions',
      status: 'stopped',
      goal: {
        status: 'active',
        objective:
          'Solve the autonomous goal problem and produce a verifier before stopping.',
      },
      sessionId: 'goal123',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain('status: stopped');
    expect(status).toContain('goal: active');
    expect(status).toContain(
      'goal objective: Solve the autonomous goal problem and produce a verifier before stopping.',
    );
  });

  it('shows the subscription line after api when subscription routing is active', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'gpt55',
      api: 'included TeXRA access',
      subscription: true,
      approval: 'ask',
      status: 'running',
      queuedFollowUpMessages: [],
    });

    expect(status).toContain(
      [
        'api: included TeXRA access',
        'subscription: on (Codex models use your ChatGPT plan)',
        'approval: ask',
      ].join('\n'),
    );
  });

  it('omits the subscription line when subscription routing is inactive', () => {
    const status = formatCliSessionStatus({
      agent: 'chat',
      model: 'gpt55',
      api: 'included TeXRA access',
      subscription: false,
      approval: 'ask',
      status: 'running',
      queuedFollowUpMessages: [],
    });

    expect(status).not.toContain('subscription:');
  });

  it('includes team identity when a chat was launched from a preset', () => {
    expect(
      formatCliSessionStatus({
        agent: 'orchestrator',
        model: 'harness-model',
        teamName: 'Physicist',
        api: 'personal',
        approval: 'ask',
        status: 'running',
        queuedFollowUpMessages: [],
      }),
    ).toContain(['team: Physicist', 'agent: orchestrator'].join('\n'));
  });

  it('uses the footer label for an idle waiting stream', () => {
    expect(formatCliStatusLabel(STREAM_PHASE.WAITING)).toBe('idle');
    expect(
      formatCliSessionStatus({
        agent: 'research',
        model: 'deepseekT',
        api: 'included TeXRA access',
        approval: 'ask before privileged actions',
        status: STREAM_PHASE.WAITING,
        queuedFollowUpMessages: [],
      }),
    ).toContain('status: idle');
  });

  it('reads queued follow-ups from the queue manager for status details', () => {
    const queueManager = new ToolUseFollowUpQueue();
    const queue = queueManager.acquire(STREAM_ID);
    queueManager.drain(STREAM_ID);
    try {
      queue.enqueue({ text: 'Fresh queue message' });

      expect(queueManager.getAll(STREAM_ID)).toEqual(['Fresh queue message']);
    } finally {
      queueManager.drain(STREAM_ID);
    }
  });
});

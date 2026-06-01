import { describe, expect, it } from 'vitest';

import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import {
  formatCliStatusLabel,
  formatCliSessionStatus,
} from '@cli/chat/tui/sessionStatus';
import { STREAM_STATUS } from '@shared/schemas';

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
      'auto-approvals: delegated tasks, bash commands, file edits',
    );
    expect(status).not.toContain('all privileged actions');
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
    expect(formatCliStatusLabel(STREAM_STATUS.WAITING)).toBe('idle');
    expect(
      formatCliSessionStatus({
        agent: 'research',
        model: 'deepseekT',
        api: 'included relay',
        approval: 'ask before privileged actions',
        status: STREAM_STATUS.WAITING,
        queuedFollowUpMessages: [],
      }),
    ).toContain('status: idle');
  });

  it('reads queued follow-ups from the queue manager for status details', () => {
    const queue = ToolUseFollowUpQueue.acquire(STREAM_ID);
    ToolUseFollowUpQueue.drain(STREAM_ID);
    try {
      queue.enqueue('Fresh queue message');

      expect(ToolUseFollowUpQueue.getAll(STREAM_ID)).toEqual([
        'Fresh queue message',
      ]);
    } finally {
      ToolUseFollowUpQueue.drain(STREAM_ID);
    }
  });
});

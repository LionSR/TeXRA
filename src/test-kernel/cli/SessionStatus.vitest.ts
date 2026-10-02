import { describe, expect, it } from 'vitest';

import {
  formatCliSessionStatus,
  taskCostStatus,
  type CliSessionStatusInput,
} from '@cli/chat/tui/sessionStatus';
import type { RunId } from '@shared/schemas';

import { makeRunView, viewWith } from './fixtures/sessionViewFixture';

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

  it("breaks the task's cost down by agent, the root's tree total first", () => {
    // Failure mode: the total names the focused run's own calls only.
    const zero = { inputTokens: 0, outputTokens: 0 };
    const root = makeRunView({
      id: 'root' as RunId,
      label: 'main',
      usage: { ...zero, cost: 0.12 },
      treeUsage: { ...zero, cost: 0.84 },
    });
    const child = makeRunView({
      id: 'child' as RunId,
      label: 'Referee A',
      parentId: root.id,
      ancestors: [{ id: root.id, label: 'main' }],
      usage: { ...zero, cost: 0.21 },
      treeUsage: { ...zero, cost: 0.72 },
    });
    const view = viewWith([root, child]);
    const status = sessionStatus({ cost: taskCostStatus(view, child) });

    expect(status).toContain(
      [
        'cost: $0.840, agents included',
        '  own model calls: $0.120',
        '  Referee A: $0.720',
      ].join('\n'),
    );
  });
});

import { describe, expect, it } from 'vitest';

import { STREAM_STATUS } from '@shared/schemas';

import {
  buildStatusBarDisplay,
  statusBarSegmentText,
} from '../../../packages/cli/src/chat/tui/panes/StatusBar';
import { NO_BYPASS } from '../../../packages/cli/src/chat/tui/state/cliState';

describe('CLI StatusBar display model', () => {
  it('keeps idle state compact and omits static agent/model names', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.WAITING,
      pendingExitHint: false,
      bypass: NO_BYPASS,
      queuedFollowUps: 0,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      model: 'deepseekT',
      apiMode: 'api',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      'api',
    ]);
    expect(display.right).toBeUndefined();
    expect(display.bindings).toContain('[/api]api');
    expect(display.left.map(statusBarSegmentText)).not.toContain('deepseekT');
  });

  it('shows live running signals and approval depth', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      bypass: NO_BYPASS,
      queuedFollowUps: 2,
      usage: { inputTokens: 80_000, outputTokens: 25_000, cost: 0 },
      conversation: { conversationTurns: 2, toolCallCount: 7 },
      activeSubagents: 2,
      activeProcesses: 1,
      approvalDepth: 3,
      model: 'deepseekT',
      apiMode: 'relay',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      'relay',
      'r2',
      '105k/1M (10%)',
      '2 sub',
      '1 proc',
      '3 approvals',
    ]);
    expect(display.right).toBe('queued: 2');
  });

  it('preserves YOLO and BYPASS badges without agent/model text', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      bypass: { superYolo: true, toolEdit: true },
      queuedFollowUps: 0,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      model: 'deepseekT',
      apiMode: 'api',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      'api',
      'YOLO',
      'BYPASS',
    ]);
    expect(display.left.at(-2)).toMatchObject({
      badge: true,
      badgeColor: 'red',
    });
    expect(display.left.at(-1)).toMatchObject({
      badge: true,
      badgeColor: 'yellow',
    });
  });
});

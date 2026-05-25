import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  defaultShortcutModifierLabel,
  statusBarSegmentText,
} from '@cli/chat/tui/panes/StatusBar';
import { NO_BYPASS } from '@cli/chat/tui/state/cliState';
import { STREAM_STATUS } from '@shared/schemas';

describe('CLI StatusBar display model', () => {
  it('keeps idle state compact and omits static agent/model names', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.WAITING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUps: 0,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: 'api',
      shortcutModifierLabel: 'Alt',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      'api',
    ]);
    expect(display.right).toBeUndefined();
    expect(display.bindings).toContain('[/api]api');
    expect(display.bindings).toContain('[/model]models');
    // [Ctrl-J]newline must be visible — the binding exists in BaseTextInput
    // (see #4399) but used to be discoverable only via source diving.
    expect(display.bindings).toContain('[Ctrl-J]newline');
    expect(display.bindings).not.toContain('[Alt-s]subagents');
    // Stream-navigation hints stay hidden in a single-stream chat.
    expect(display.bindings).not.toContain('[Tab]streams');
    expect(display.bindings).not.toContain('[Alt-1..9]focus');
    expect(display.left.map(statusBarSegmentText)).not.toContain('deepseekT');
  });

  it('shows live running signals and approval depth', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUps: 2,
      usage: { inputTokens: 80_000, outputTokens: 25_000, cost: 0 },
      conversation: { conversationTurns: 2, toolCallCount: 7 },
      activeSubagents: 2,
      activeProcesses: 1,
      approvalDepth: 3,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: 'relay',
      shortcutModifierLabel: 'Alt',
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
    expect(display.bindings).toContain('[Alt-s]subagents');
    // Stream-navigation hints appear once more than one stream is live.
    expect(display.bindings).toContain('[Tab]streams');
    expect(display.bindings).toContain('[Alt-1..9]focus');
  });

  it('preserves YOLO and BYPASS badges without agent/model text', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: { superYolo: true, toolEdit: true },
      queuedFollowUps: 0,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: 'api',
      shortcutModifierLabel: 'Alt',
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

  it('shows the resume command while exit confirmation is armed', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: true,
      pendingExitResumeId: 'abc123',
      bypass: NO_BYPASS,
      queuedFollowUps: 0,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: 'api',
      shortcutModifierLabel: 'Alt',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'Press Ctrl-C again to exit',
      'api',
    ]);
    expect(display.bindings).toBe(
      'Resume this session with: texra --resume abc123',
    );
  });

  it('uses Option labels for meta shortcuts on macOS', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.WAITING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUps: 0,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: 'api',
      shortcutModifierLabel: defaultShortcutModifierLabel('darwin'),
    });

    expect(display.bindings).toContain('[Option-1..9]focus');
    expect(display.bindings).toContain('[Option-p]tasks');
    expect(display.bindings).toContain('[Option-s]subagents');
  });
});

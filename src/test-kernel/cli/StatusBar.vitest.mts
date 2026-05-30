import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  defaultShortcutModifierLabel,
  queuedFollowUpsSummary,
  statusBarSegmentText,
} from '@cli/chat/tui/panes/StatusBar';
import { NO_BYPASS } from '@cli/chat/tui/state/cliState';
import { STREAM_STATUS } from '@shared/schemas';

describe('CLI StatusBar display model', () => {
  it('previews queued follow-up messages without duplicating the count', () => {
    expect(queuedFollowUpsSummary([])).toBeUndefined();
    expect(queuedFollowUpsSummary(['Keep the proof under one page.'])).toBe(
      'Keep the proof under one page.',
    );
    expect(
      queuedFollowUpsSummary([
        'Keep the proof under one page.',
        'Also mention the finite monoid argument.',
      ]),
    ).toBe('Keep the proof under one page.');
  });

  it('hides queued follow-up previews when the right side has no safe width', () => {
    expect(queuedFollowUpsSummary(['Keep the proof under one page.'], 20)).toBe(
      'Keep the proof unde…',
    );
    expect(
      queuedFollowUpsSummary(['Keep the proof under one page.'], 11),
    ).toBeUndefined();
  });

  it('truncates queued follow-up previews by display columns', () => {
    expect(queuedFollowUpsSummary(['請補充一個單調有界證明。'], 20)).toBe(
      '請補充一個單調有界…',
    );
  });

  it('keeps queued follow-up counts in the durable left status segments', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: ['Keep the proof under one page.'],
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
      'queued 1',
    ]);
    expect(display.left.at(-1)).toMatchObject({ color: 'yellow' });
    expect(display.right).toBe('Keep the proof under one page.');
  });

  it('keeps idle state compact and omits static agent/model names', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.WAITING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
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
    expect(display.bindings).not.toContain('[Shift-Enter]newline');
    expect(display.bindings).toContain('[Ctrl-C]exit');
    expect(display.bindings).not.toContain('[Ctrl-C]stop');
    expect(display.bindings).not.toContain('[Alt-s]subagents');
    // Stream-navigation hints stay hidden in a single-stream chat.
    expect(display.bindings).not.toContain('[Tab]streams');
    expect(display.bindings).not.toContain('[Alt-1..9]focus');
    expect(display.left.map(statusBarSegmentText)).not.toContain('deepseekT');
  });

  it('advertises Shift-Enter for newline when the Kitty protocol is active', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.WAITING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
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
      shiftEnterNewline: true,
    });

    expect(display.bindings).toContain('[Shift-Enter]newline');
    expect(display.bindings).not.toContain('[Ctrl-J]newline');
  });

  it('shows live running signals and approval depth', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [
        'Keep the proof under one page.',
        'Also mention the finite monoid argument.',
      ],
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
      ctrlCAction: 'stop',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      'relay',
      'r2',
      '105k/1M (10%)',
      'queued 2',
      '2 sub',
      '1 proc',
      '3 approvals',
    ]);
    expect(display.right).toBe('Keep the proof under one page.');
    expect(display.bindings).toContain('[Alt-s]subagents');
    expect(display.bindings).toContain('[Ctrl-C]stop');
    // Stream-navigation hints appear once more than one stream is live.
    expect(display.bindings).toContain('[Tab]streams');
    expect(display.bindings).toContain('[Alt-1..9]focus');
  });

  it('shows a live elapsed segment only while running', () => {
    const runningInput = {
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 110_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
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
    };
    const running = buildStatusBarDisplay(runningInput);

    expect(running.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '110s',
      'api',
    ]);

    const justStarted = buildStatusBarDisplay({
      ...runningInput,
      elapsedMs: -20_000,
    });
    expect(justStarted.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '0s',
      'api',
    ]);

    // The same elapsed reading is suppressed once the turn is no longer running.
    const idle = buildStatusBarDisplay({
      status: STREAM_STATUS.WAITING,
      elapsedMs: 110_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
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

    expect(idle.left.map(statusBarSegmentText)).toEqual(['◆', 'idle', 'api']);
  });

  it('preserves YOLO and BYPASS badges without agent/model text', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: { superYolo: true, toolEdit: true },
      queuedFollowUpMessages: [],
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

  it('budgets queued follow-up previews with rendered badge padding', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: { superYolo: true, toolEdit: true },
      queuedFollowUpMessages: ['Keep the proof under one page.'],
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
      width: 60,
    });

    expect(display.right).toBe('Keep the proof un…');
    expect(display.bindings).toContain('[Ctrl-C]exit');
  });

  it('shows the resume command while exit confirmation is armed', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: true,
      pendingExitResumeId: 'abc123',
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
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
      queuedFollowUpMessages: [],
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

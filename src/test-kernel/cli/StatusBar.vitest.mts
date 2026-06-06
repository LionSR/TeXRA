import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  ctrlCActionForFocus,
  defaultShortcutModifierLabel,
  queuedFollowUpsSummary,
  statusBarCanStopVisibleRun,
  statusBarDisplaySlice,
  statusBarSegmentText,
} from '@cli/chat/tui/panes/StatusBar';
import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import { STREAM_STATUS } from '@shared/schemas';

const PERSONAL_API_MODE_LABEL = shortCliApiMode('personal');

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
    ).toBe('1. Keep the proof und… · 2. Also mention the f…');
  });

  it('marks hidden queued follow-up previews', () => {
    expect(queuedFollowUpsSummary(['first', 'second', 'third'])).toBe(
      '1. first · 2. second · +1 more',
    );
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

  it('uses clear compact labels for API access mode', () => {
    expect(shortCliApiMode('included')).toBe('relay');
    expect(shortCliApiMode('personal')).toBe('keys');
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.right).toBeUndefined();
    expect(display.bindings).toContain('[/api]api');
    expect(display.bindings).toContain('[/model]models');
    expect(display.bindings).not.toContain('[/agent]agents');
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

  it('advertises root agent selection while setup can still change it', () => {
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
      agentSelectionAvailable: true,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'gpt54',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      width: 80,
    });

    expect(display.bindings).toBe(
      '[/agent]agents  [/model]models  [/api]api  [Ctrl-J]newline  [Ctrl-C]exit',
    );
  });

  it('keeps root agent selection visible when setup bindings get narrow', () => {
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
      agentSelectionAvailable: true,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'gpt54',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      width: 50,
    });

    expect(display.bindings).toContain('[/agent]agents');
    expect(display.bindings).toContain('[Ctrl-C]exit');
    expect(display.bindings).not.toContain('[/model]models');
    expect(display.bindings).not.toContain('[/api]api');
  });

  it('hides task shortcuts when no task rows exist', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 12_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      taskControlsAvailable: false,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: 'relay',
      shortcutModifierLabel: 'Option',
      ctrlCAction: 'stop',
    });

    expect(display.bindings).toContain('[/status]details');
    expect(display.bindings).toContain('[Ctrl-C]stop');
    expect(display.bindings).not.toContain('[Option-p]tasks');
  });

  it('keeps subagent shortcuts grouped when task shortcuts are hidden', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 12_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 1,
      activeProcesses: 0,
      approvalDepth: 0,
      taskControlsAvailable: false,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: 'relay',
      shortcutModifierLabel: 'Option',
      ctrlCAction: 'stop',
    });

    expect(display.bindings).not.toContain('[Option-p]tasks');
    expect(display.bindings).toContain('[Option-s]subagents');
    expect(display.bindings.indexOf('[Option-s]subagents')).toBeLessThan(
      display.bindings.indexOf('[/status]details'),
    );
    expect(display.bindings.indexOf('[Option-s]subagents')).toBeLessThan(
      display.bindings.indexOf('[Ctrl-C]stop'),
    );
  });

  it('advertises scoped child transcript paging only when a child page is focused', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 1,
      activeProcesses: 0,
      approvalDepth: 0,
      taskControlsAvailable: false,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: 'relay',
      shortcutModifierLabel: 'Option',
      scopedTranscriptScrollable: true,
      ctrlCAction: 'stop root',
      width: 100,
    });

    expect(display.bindings).toContain('PgUp');
    expect(display.bindings).toContain('scroll');
    expect(display.bindings).toContain('[Tab]streams');
    expect(display.bindings).toContain('[Ctrl-C]stop root');
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
      apiMode: PERSONAL_API_MODE_LABEL,
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
    expect(display.right).toBe(
      '1. Keep the proof und… · 2. Also mention the f…',
    );
    expect(display.bindings).toContain('[Alt-s]subagents');
    expect(display.bindings).toContain('[Ctrl-C]stop');
    // Stream-navigation hints appear once more than one stream is live.
    expect(display.bindings).toContain('[Tab]streams');
    expect(display.bindings).toContain('[Alt-1..9]focus');
  });

  it('keeps critical controls visible in narrow subagent sessions', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 88_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 3,
      activeProcesses: 1,
      approvalDepth: 0,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      width: 60,
    });

    expect(display.bindings).toBe(
      '[Tab]streams  [Alt-p]tasks  [Alt-s]subagents  [Ctrl-C]stop',
    );
    expect(display.bindings).toContain('[Ctrl-C]stop');
  });

  it('prefers the task picker when one child-control shortcut fits', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 88_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 3,
      activeProcesses: 1,
      approvalDepth: 0,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Option',
      ctrlCAction: 'stop',
      width: 44,
    });

    expect(display.bindings).toBe('[Option-p]tasks  [Ctrl-C]stop');
    expect(display.bindings).not.toContain('[Option-s]subagents');
  });

  it('drops low-priority status details before narrow footers lose separators', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 75_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 3,
      activeProcesses: 1,
      approvalDepth: 0,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      width: 30,
      shortcutsActive: false,
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '75s',
      PERSONAL_API_MODE_LABEL,
      '3 sub',
    ]);
    expect(display.left.map(statusBarSegmentText).join(' ')).not.toContain(
      `${PERSONAL_API_MODE_LABEL}3`,
    );
  });

  it('drops approval depth before returning an over-wide narrow status', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 75_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 3,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      width: 30,
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '75s',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('drops elapsed before returning an over-wide critical-only status', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 75_000,
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      width: 16,
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('keeps queued follow-up previews aligned with visible queued counts', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      elapsedMs: 75_000,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: ['Keep the proof under one page.'],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 3,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      width: 30,
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '75s',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.right).toBeUndefined();
  });

  it('can hide queued follow-up previews while keeping the durable count', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: ['Keep the proof under one page.'],
      queuedFollowUpPreview: false,
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      width: 80,
    });

    expect(display.left.map(statusBarSegmentText)).toContain('queued 1');
    expect(display.right).toBeUndefined();
  });

  it('scopes Ctrl-C stop to the root when focus is on a child stream', () => {
    const parentStream = new Map([['child', 'root']]);

    expect(
      ctrlCActionForFocus({
        activeStreamId: 'root',
        canStopActiveRun: true,
        parentStream,
      }),
    ).toBe('stop');
    expect(
      ctrlCActionForFocus({
        activeStreamId: 'child',
        canStopActiveRun: true,
        parentStream,
      }),
    ).toBe('stop root');
    expect(
      ctrlCActionForFocus({
        activeStreamId: 'child',
        canStopActiveRun: false,
        parentStream,
      }),
    ).toBe('exit');

    const baseDisplayInput = {
      status: STREAM_STATUS.STOPPED,
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop root',
    } as const;
    const display = buildStatusBarDisplay(baseDisplayInput);

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'stopped',
      'root active',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.bindings).toContain('[Ctrl-C]stop root');

    const liveChildDisplay = buildStatusBarDisplay({
      ...baseDisplayInput,
      status: STREAM_STATUS.RUNNING,
    });
    expect(liveChildDisplay.left.map(statusBarSegmentText)).not.toContain(
      'root active',
    );

    const stoppedRootDisplay = buildStatusBarDisplay({
      ...baseDisplayInput,
      ctrlCAction: 'stop',
    });
    expect(stoppedRootDisplay.left.map(statusBarSegmentText)).not.toContain(
      'root active',
    );
  });

  it('treats visible live stream status as stoppable', () => {
    const root = 'root';
    const child = 'child';
    const grandchild = 'grandchild';
    const streams = new Map([
      [root, { streamId: root, status: STREAM_STATUS.RUNNING }],
      [child, { streamId: child, status: STREAM_STATUS.STOPPED }],
      [grandchild, { streamId: grandchild, status: STREAM_STATUS.STOPPED }],
    ]);

    expect(
      statusBarCanStopVisibleRun({
        activeStreamId: root,
        parentStream: new Map([[child, root]]),
        status: STREAM_STATUS.RUNNING,
        streams,
      }),
    ).toBe(true);
    expect(
      statusBarCanStopVisibleRun({
        activeStreamId: child,
        parentStream: new Map([[child, root]]),
        status: STREAM_STATUS.STOPPED,
        streams,
      }),
    ).toBe(true);
    expect(
      statusBarCanStopVisibleRun({
        activeStreamId: grandchild,
        parentStream: new Map([
          [child, root],
          [grandchild, child],
        ]),
        status: STREAM_STATUS.STOPPED,
        streams,
      }),
    ).toBe(true);
    expect(
      statusBarCanStopVisibleRun({
        activeStreamId: root,
        parentStream: new Map([[child, root]]),
        status: STREAM_STATUS.WAITING,
        streams: new Map([
          [root, { streamId: root, status: STREAM_STATUS.WAITING }],
        ]),
      }),
    ).toBe(false);
  });

  it('uses focused stream status when a stopped child stream is focused', () => {
    const rootSlice = {
      status: STREAM_STATUS.RUNNING,
    } as StreamSlice;
    const childSlice = {
      status: STREAM_STATUS.STOPPED,
    } as StreamSlice;
    const waitingChildSlice = {
      status: STREAM_STATUS.WAITING,
    } as StreamSlice;
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      ['root', rootSlice],
      ['child', childSlice],
      ['waiting-child', waitingChildSlice],
    ]);

    expect(
      statusBarDisplaySlice({
        activeStreamId: 'child',
        parentStream: new Map([['child', 'root']]),
        streams,
      }),
    ).toBe(childSlice);
    expect(
      statusBarDisplaySlice({
        activeStreamId: 'waiting-child',
        parentStream: new Map([['waiting-child', 'root']]),
        streams,
      }),
    ).toBe(waitingChildSlice);
    expect(
      statusBarDisplaySlice({
        activeStreamId: 'root',
        parentStream: new Map([['child', 'root']]),
        streams,
      }),
    ).toBe(rootSlice);
  });

  it('keeps status discoverable in narrow single-stream sessions', () => {
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      width: 50,
    });

    expect(display.bindings).toBe(
      '[Alt-p]tasks  [/status]details  [Ctrl-C]exit',
    );
  });

  it('hides inactive global bindings while a foreground panel owns input', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 2,
      activeProcesses: 1,
      approvalDepth: 1,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      shortcutsActive: false,
    });

    expect(display.left.map(statusBarSegmentText)).toContain('1 approval');
    expect(display.bindings).toBe(
      'Use foreground panel shortcuts  [Esc]close  [Ctrl-C]stop',
    );
    expect(display.bindings).not.toContain('[Tab]streams');
    expect(display.bindings).not.toContain('[Alt-p]tasks');
    expect(display.bindings).not.toContain('[/model]models');
  });

  it('labels foreground user questions as questions instead of approvals', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 1,
      approvalKind: 'question',
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      foregroundEscapeAction: 'skip',
      shortcutsActive: false,
    });

    expect(display.left.map(statusBarSegmentText)).toContain('1 question');
    expect(display.left.map(statusBarSegmentText)).not.toContain('1 approval');
    expect(display.bindings).toContain('[Esc]skip');
  });

  it('shows cancel for non-question approval foregrounds', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 1,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      foregroundEscapeAction: 'cancel',
      shortcutsActive: false,
    });

    expect(display.bindings).toContain('[Esc]cancel');
  });

  it('keeps escape and Ctrl-C actions visible in narrow foreground panels', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 3,
      activeProcesses: 1,
      approvalDepth: 0,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      shortcutsActive: false,
      width: 40,
    });

    expect(display.bindings).toBe('[Esc]close  [Ctrl-C]stop');
  });

  it('falls back to the bare Ctrl-C action in tiny foreground panels', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: NO_BYPASS,
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 3,
      activeProcesses: 1,
      approvalDepth: 0,
      subagentControlsAvailable: true,
      hasMultipleStreams: true,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      ctrlCAction: 'stop',
      shortcutsActive: false,
      width: 15,
    });

    expect(display.bindings).toBe('[Ctrl-C]stop');
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
    };
    const running = buildStatusBarDisplay(runningInput);

    expect(running.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '110s',
      PERSONAL_API_MODE_LABEL,
    ]);

    const justStarted = buildStatusBarDisplay({
      ...runningInput,
      elapsedMs: -20_000,
    });
    expect(justStarted.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '0s',
      PERSONAL_API_MODE_LABEL,
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
    });

    expect(idle.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('preserves distinct YOLO and auto-approval badges', () => {
    const display = buildStatusBarDisplay({
      status: STREAM_STATUS.RUNNING,
      pendingExitHint: false,
      pendingExitResumeId: undefined,
      bypass: { bash: true, superYolo: true, toolEdit: true },
      queuedFollowUpMessages: [],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
      'YOLO',
      'AUTO-BASH',
      'AUTO-APPROVE',
    ]);
    expect(display.left.at(-3)).toMatchObject({
      badge: true,
      badgeColor: 'red',
    });
    expect(display.left.at(-2)).toMatchObject({
      badge: true,
      badgeColor: 'yellow',
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
      bypass: { bash: false, superYolo: true, toolEdit: true },
      queuedFollowUpMessages: ['Keep the proof under one page.'],
      usage: undefined,
      conversation: undefined,
      activeSubagents: 0,
      activeProcesses: 0,
      approvalDepth: 0,
      subagentControlsAvailable: false,
      hasMultipleStreams: false,
      model: 'deepseekT',
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      width: 61,
    });

    expect(display.right).toBe('Keep the pr…');
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'Press Ctrl-C again to exit',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.bindings).toBe(
      'Resume this session with: texra --resume abc123',
    );
  });

  it('keeps the exit confirmation visible in very narrow footers', () => {
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: 'Alt',
      width: 29,
    });

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'Press Ctrl-C again to ex…',
    ]);
    expect(display.bindings).toBe(
      'Resume this session with: texra --resume abc123',
    );
  });

  it('uses portable Esc labels for meta shortcuts on macOS', () => {
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
      apiMode: PERSONAL_API_MODE_LABEL,
      shortcutModifierLabel: defaultShortcutModifierLabel('darwin'),
    });

    expect(display.bindings).toContain('[Esc 1..9]focus');
    expect(display.bindings).toContain('[Esc p]tasks');
    expect(display.bindings).toContain('[Esc s]subagents');
    expect(display.bindings).not.toContain('[Option-p]tasks');
  });
});

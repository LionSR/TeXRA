import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  ctrlCActionForFocus,
  queuedFollowUpsSummary,
  statusBarSegmentText,
  statusBarStreamTarget,
  type StatusBarDisplayInput,
} from '@cli/chat/tui/panes/statusBarDisplay';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import { KEY_HINT_SEPARATOR } from '@cli/chat/tui/ui/KeyHints';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import { STREAM_PHASE, STREAM_SUBSTATE } from '@shared/schemas';

const PERSONAL_API_MODE_LABEL = shortCliApiMode('personal');
const COMPLETED_REVIEW_FOLLOWUP =
  '<orchestrator-followup><subagent-result id="child-q" agent="review" category="toolUse" status="completed"><response>All good &lt;ok&gt;</response></subagent-result></orchestrator-followup>';
const PROGRESS_REVIEW_FOLLOWUP =
  '<orchestrator-followup><subagent-progress id="child-q" agent="review" category="toolUse" type="todos" completed="6" active="0" pending="0"/></orchestrator-followup>';

// Idle single-stream baseline; each test overrides only the fields it exercises.
function statusInput(
  overrides: Partial<StatusBarDisplayInput> = {},
): StatusBarDisplayInput {
  return {
    status: STREAM_PHASE.WAITING,
    pendingExitHint: false,
    pendingExitResumeId: undefined,
    bypass: NO_BYPASS,
    queuedFollowUpMessages: [],
    usage: undefined,
    roundStage: undefined,
    activeSubagents: 0,
    activeProcesses: 0,
    approvalDepth: 0,
    subagentControlsAvailable: false,
    sessionNavigationAvailable: false,
    model: 'deepseekT',
    apiMode: PERSONAL_API_MODE_LABEL,
    shortcutModifierLabel: 'Alt',
    ...overrides,
  };
}

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

  it('summarizes queued subagent follow-up XML in the status preview', () => {
    expect(queuedFollowUpsSummary([COMPLETED_REVIEW_FOLLOWUP], 80)).toBe(
      '✓ review completed All good <ok>',
    );

    const progressSummary = queuedFollowUpsSummary(
      [PROGRESS_REVIEW_FOLLOWUP],
      80,
    );
    expect(progressSummary).toBe(
      '⟳ review · todos · 6 done, 0 active, 0 pending',
    );
    expect(progressSummary).not.toContain('<subagent-progress');

    const listSummary = queuedFollowUpsSummary([
      PROGRESS_REVIEW_FOLLOWUP,
      'Check the edge case.',
    ]);
    expect(listSummary).toContain('1. ⟳ review');
    expect(listSummary).not.toContain('<orchestrator-followup>');
    expect(listSummary).not.toContain('<subagent-progress');
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
    expect(shortCliApiMode('included')).toBe('included');
    expect(shortCliApiMode('personal')).toBe('personal');
  });

  it('keeps an ephemeral transcript warning in the durable status row', () => {
    const display = buildStatusBarDisplay(
      statusInput({ transcriptMode: 'ephemeral' }),
    );

    expect(display.left.map(statusBarSegmentText)).toContain(
      'EPHEMERAL TRANSCRIPT',
    );
    expect(
      display.left.find(
        (segment) => statusBarSegmentText(segment) === 'EPHEMERAL TRANSCRIPT',
      ),
    ).toMatchObject({ badge: true, badgeColor: 'yellow' });
    expect(display.bindings).not.toContain('Resume this session');
  });

  it('surfaces non-default approval policies in the durable status row', () => {
    const input = statusInput({ approvalPolicy: 'ask' });
    const ask = buildStatusBarDisplay(input);

    expect(ask.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
    ]);

    const deny = buildStatusBarDisplay({
      ...input,
      approvalPolicy: 'never',
    });
    expect(deny.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
      'deny',
    ]);
    expect(deny.left.at(-1)).toMatchObject({ color: 'yellow' });

    const yolo = buildStatusBarDisplay({
      ...input,
      approvalPolicy: 'yolo',
    });
    expect(yolo.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
      'yolo',
    ]);
    expect(yolo.left.at(-1)).toMatchObject({ color: 'red' });
  });

  it('keeps queued follow-up counts in the durable left status segments', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        queuedFollowUpMessages: ['Keep the proof under one page.'],
      }),
    );

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
    const display = buildStatusBarDisplay(statusInput());

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.right).toBeUndefined();
    expect(display.bindings).toContain('/api api');
    expect(display.bindings).toContain('/model models');
    expect(display.bindings).not.toContain('/agent agents');
    // Ctrl-J newline must be visible — the binding exists in BaseTextInput
    // (see #4399) but used to be discoverable only via source diving.
    expect(display.bindings).toContain('Ctrl-J newline');
    expect(display.bindings).not.toContain('Shift-Enter newline');
    expect(display.bindings).toContain('Ctrl-C exit');
    expect(display.bindings).not.toContain('Ctrl-C stop');
    expect(display.bindings).not.toContain('Alt-s subagents');
    // Stream-navigation hints stay hidden in a single-stream chat.
    expect(display.bindings).not.toContain('Tab sessions');
    expect(display.bindings).not.toContain('Alt-1..9 focus');
    expect(display.left.map(statusBarSegmentText)).not.toContain('deepseekT');
  });

  it('renders bindings in the shared KeyHints hint format', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        transcriptAvailable: true,
      }),
    );

    // One hint vocabulary across the TUI: unbracketed `key action` pairs
    // joined by the KeyHints separator, matching every modal footer (#8199).
    expect(display.bindings).toContain(KEY_HINT_SEPARATOR);
    expect(display.bindings).not.toMatch(/[[\]]/);
  });

  it('advertises the transcript viewer when the focused stream has history', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        transcriptAvailable: true,
        width: 80,
      }),
    );

    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).toContain('Alt-s subagents');
  });

  it('advertises list-owned keys while the session list has focus', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        sessionNavigationAvailable: true,
        sessionListFocused: true,
        width: 80,
      }),
    );

    expect(display.bindings).toContain('Up/Down select');
    expect(display.bindings).toContain('Enter focus');
    expect(display.bindings).toContain('Tab input');
    expect(display.bindings).toContain('Esc input');
    expect(display.bindings).not.toContain('Tab sessions');
  });

  it('keeps the transcript shortcut in narrow stream views', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        taskControlsAvailable: false,
        sessionNavigationAvailable: true,
        transcriptAvailable: true,
        width: 60,
      }),
    );

    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).toContain('Ctrl-C exit');
  });

  it('prefers transcript over stream cycling when the bar is very narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        taskControlsAvailable: false,
        sessionNavigationAvailable: true,
        transcriptAvailable: true,
        width: 42,
      }),
    );

    expect(display.bindings).toBe('Ctrl-T transcript · Ctrl-C exit');
  });

  it('advertises root agent selection while setup can still change it', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        taskControlsAvailable: false,
        model: 'gpt54',
        width: 80,
      }),
    );

    expect(display.bindings).toBe(
      '/agent agents · /model models · /api api · Ctrl-J newline · Ctrl-C exit',
    );
  });

  it('does not let setup bindings hide the transcript viewer when it fits', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        taskControlsAvailable: false,
        model: 'gpt54',
        transcriptAvailable: true,
        width: 100,
      }),
    );

    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).toContain('/agent agents');
  });

  it('keeps model and API controls visible after local-command transcript rows', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        taskControlsAvailable: false,
        transcriptAvailable: true,
        width: 80,
      }),
    );

    expect(display.bindings).toBe(
      '/agent agents · /model models · /api api · Ctrl-C exit',
    );
  });

  it('keeps child controls ahead of setup bindings after a root run completes', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        taskControlsAvailable: true,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        transcriptAvailable: true,
        width: 80,
      }),
    );

    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Alt-p tasks');
    expect(display.bindings).toContain('Alt-s subagents');
    expect(display.bindings).not.toContain('/model models');
    expect(display.bindings).not.toContain('/api api');
  });

  it('keeps root agent selection visible when setup bindings get narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        taskControlsAvailable: false,
        model: 'gpt54',
        width: 50,
      }),
    );

    expect(display.bindings).toContain('/agent agents');
    expect(display.bindings).toContain('Ctrl-C exit');
    expect(display.bindings).not.toContain('/model models');
    expect(display.bindings).not.toContain('/api api');
  });

  it('hides task shortcuts when no task rows exist', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 12_000,
        taskControlsAvailable: false,
        apiMode: 'relay',
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop',
      }),
    );

    expect(display.bindings).toContain('/status details');
    expect(display.bindings).toContain('Ctrl-C stop');
    expect(display.bindings).not.toContain('Option-p tasks');
  });

  it('keeps subagent shortcuts grouped when task shortcuts are hidden', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 12_000,
        activeSubagents: 1,
        taskControlsAvailable: false,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        apiMode: 'relay',
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop',
      }),
    );

    expect(display.bindings).not.toContain('Option-p tasks');
    expect(display.bindings).toContain('Option-s subagents');
    expect(display.bindings.indexOf('Option-s subagents')).toBeLessThan(
      display.bindings.indexOf('/status details'),
    );
    expect(display.bindings.indexOf('Option-s subagents')).toBeLessThan(
      display.bindings.indexOf('Ctrl-C stop'),
    );
  });

  it('does not advertise in-pane paging for focused child streams', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        activeSubagents: 1,
        taskControlsAvailable: false,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        apiMode: 'relay',
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop root',
        width: 100,
      }),
    );

    expect(display.bindings).not.toContain('PgUp');
    expect(display.bindings).not.toContain('scroll');
    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Ctrl-C stop root');
  });

  it('advertises Shift-Enter for newline when the Kitty protocol is active', () => {
    const display = buildStatusBarDisplay(
      statusInput({ shiftEnterNewline: true }),
    );

    expect(display.bindings).toContain('Shift-Enter newline');
    expect(display.bindings).not.toContain('Ctrl-J newline');
  });

  it('shows live running signals and approval depth', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        queuedFollowUpMessages: [
          'Keep the proof under one page.',
          'Also mention the finite monoid argument.',
        ],
        usage: { inputTokens: 80_000, outputTokens: 25_000, cost: 0 },
        roundStage: { index: 1 },
        activeSubagents: 2,
        activeProcesses: 1,
        approvalDepth: 3,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        apiMode: 'relay',
        ctrlCAction: 'stop',
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      'relay',
      'r2',
      '80k/1.0M (8%)',
      'queued 2',
      '2 sub',
      '1 proc',
      '3 approvals',
    ]);
    expect(display.right).toBe(
      '1. Keep the proof und… · 2. Also mention the f…',
    );
    expect(display.bindings).toContain('Alt-s subagents');
    expect(display.bindings).toContain('Ctrl-C stop');
    // Stream-navigation hints appear once more than one stream is live.
    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Alt-1..9 focus');
  });

  it('keeps critical controls visible in narrow subagent sessions', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        activeSubagents: 3,
        activeProcesses: 1,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        ctrlCAction: 'stop',
        transcriptAvailable: true,
        width: 60,
      }),
    );

    expect(display.bindings).toBe(
      'Tab sessions · Alt-p tasks · Alt-s subagents · Ctrl-C stop',
    );
    expect(display.bindings).toContain('Ctrl-C stop');
  });

  it('prefers the task picker when one child-control shortcut fits', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        activeSubagents: 3,
        activeProcesses: 1,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop',
        transcriptAvailable: true,
        width: 44,
      }),
    );

    expect(display.bindings).toBe('Option-p tasks · Ctrl-C stop');
    expect(display.bindings).not.toContain('Option-s subagents');
  });

  it('drops low-priority status details before narrow footers lose separators', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        activeSubagents: 3,
        activeProcesses: 1,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        ctrlCAction: 'stop',
        width: 34,
        shortcutsActive: false,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '1m 15s',
      PERSONAL_API_MODE_LABEL,
      '3 sub',
    ]);
    expect(display.left.map(statusBarSegmentText).join(' ')).not.toContain(
      `${PERSONAL_API_MODE_LABEL}3`,
    );
  });

  it('drops approval depth before returning an over-wide narrow status', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        approvalDepth: 3,
        ctrlCAction: 'stop',
        width: 30,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '1m 15s',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('drops elapsed before returning an over-wide critical-only status', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        ctrlCAction: 'stop',
        width: 16,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('keeps queued follow-up previews aligned with visible queued counts', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        queuedFollowUpMessages: ['Keep the proof under one page.'],
        approvalDepth: 3,
        ctrlCAction: 'stop',
        width: 30,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '1m 15s',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.right).toBeUndefined();
  });

  it('can hide queued follow-up previews while keeping the durable count', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        queuedFollowUpMessages: ['Keep the proof under one page.'],
        queuedFollowUpPreview: false,
        ctrlCAction: 'stop',
        width: 80,
      }),
    );

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

    const baseDisplayInput = statusInput({
      status: STREAM_PHASE.CANCELLED,
      subagentControlsAvailable: true,
      sessionNavigationAvailable: true,
      ctrlCAction: 'stop root',
    });
    const display = buildStatusBarDisplay(baseDisplayInput);

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'stopped',
      'root active',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.bindings).toContain('Ctrl-C stop root');

    const liveChildDisplay = buildStatusBarDisplay({
      ...baseDisplayInput,
      status: STREAM_PHASE.RUNNING,
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

  it('labels a focused WAITING child distinctly from the root idle wording', () => {
    const rootDisplay = buildStatusBarDisplay(
      statusInput({ status: STREAM_PHASE.WAITING, isChildStream: false }),
    );
    expect(rootDisplay.left.map(statusBarSegmentText)).toContain('idle');

    const childDisplay = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.WAITING,
        isChildStream: true,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        ctrlCAction: 'stop root',
      }),
    );
    expect(childDisplay.left.map(statusBarSegmentText)).toContain(
      'waiting for you',
    );
    expect(childDisplay.left.map(statusBarSegmentText)).not.toContain('idle');
  });

  it('derives isChildStream for statusBarStreamTarget from whichever stream is actually displayed', () => {
    const root = 'root';
    const child = 'child';
    const waitingChildSlice = {
      streamId: child,
      status: STREAM_PHASE.WAITING,
    } as StreamSlice;
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      [child, waitingChildSlice],
    ]);

    expect(
      statusBarStreamTarget({
        activeStreamId: child,
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams,
      }),
    ).toMatchObject({
      displaySlice: waitingChildSlice,
      isChildStream: true,
    });

    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams,
      }),
    ).toMatchObject({
      displaySlice: undefined,
      isChildStream: false,
    });
  });

  it('projects focused status while keeping stop capability host-owned', () => {
    const root = 'root';
    const child = 'child';
    const grandchild = 'grandchild';
    const rootSlice = {
      streamId: root,
      status: STREAM_PHASE.RUNNING,
    } as StreamSlice;
    const childSlice = {
      streamId: child,
      status: STREAM_PHASE.CANCELLED,
    } as StreamSlice;
    const grandchildSlice = {
      streamId: grandchild,
      status: STREAM_PHASE.CANCELLED,
    } as StreamSlice;
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      [root, rootSlice],
      [child, childSlice],
      [grandchild, grandchildSlice],
    ]);

    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        canStopActiveRun: false,
        parentStream: new Map([[child, root]]),
        streams,
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: rootSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams,
      }),
    ).toMatchObject({
      ctrlCAction: 'stop',
      displaySlice: rootSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: child,
        canStopActiveRun: false,
        parentStream: new Map([[child, root]]),
        streams,
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: childSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: child,
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams,
      }),
    ).toMatchObject({
      ctrlCAction: 'stop root',
      displaySlice: childSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: grandchild,
        canStopActiveRun: false,
        parentStream: new Map([
          [child, root],
          [grandchild, child],
        ]),
        streams,
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: grandchildSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: grandchild,
        canStopActiveRun: true,
        parentStream: new Map([
          [child, root],
          [grandchild, child],
        ]),
        streams,
      }),
    ).toMatchObject({
      ctrlCAction: 'stop root',
      displaySlice: grandchildSlice,
    });

    expect(
      statusBarStreamTarget({
        activeStreamId: undefined,
        canStopActiveRun: true,
        canStopPendingRunWithoutStream: false,
        parentStream: new Map([[child, root]]),
        streams: new Map(),
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: undefined,
    });

    expect(
      statusBarStreamTarget({
        activeStreamId: undefined,
        canStopActiveRun: true,
        canStopPendingRunWithoutStream: true,
        parentStream: new Map([[child, root]]),
        streams: new Map(),
      }),
    ).toMatchObject({
      ctrlCAction: 'stop',
      displaySlice: undefined,
    });

    const pendingRootSlice = {
      streamId: root,
      status: undefined,
    } as StreamSlice;
    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams: new Map<StreamSlice['streamId'], StreamSlice>([
          [root, pendingRootSlice],
        ]),
      }),
    ).toMatchObject({
      ctrlCAction: 'stop',
      displaySlice: pendingRootSlice,
    });

    const waitingRootSlice = {
      streamId: root,
      status: STREAM_PHASE.WAITING,
    } as StreamSlice;
    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        canStopActiveRun: true,
        canStopPendingRunWithoutStream: true,
        parentStream: new Map([[child, root]]),
        streams: new Map<StreamSlice['streamId'], StreamSlice>([
          [root, waitingRootSlice],
        ]),
      }),
    ).toMatchObject({
      ctrlCAction: 'stop',
      displaySlice: waitingRootSlice,
    });

    const stoppedRootSlice = {
      streamId: root,
      status: STREAM_PHASE.CANCELLED,
    } as StreamSlice;
    const stoppedChildSlice = {
      streamId: child,
      status: STREAM_PHASE.CANCELLED,
    } as StreamSlice;
    const stoppedStreams = new Map<StreamSlice['streamId'], StreamSlice>([
      [root, stoppedRootSlice],
      [child, stoppedChildSlice],
    ]);
    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        // A stale host callback must not leave the footer advertising stop
        // after the visible stream tree has already become terminal.
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams: stoppedStreams,
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: stoppedRootSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: child,
        canStopActiveRun: true,
        parentStream: new Map([[child, root]]),
        streams: stoppedStreams,
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: stoppedChildSlice,
    });
    expect(
      statusBarStreamTarget({
        activeStreamId: root,
        canStopActiveRun: false,
        parentStream: new Map([[child, root]]),
        streams: new Map<StreamSlice['streamId'], StreamSlice>([
          [
            root,
            { streamId: root, status: STREAM_PHASE.WAITING } as StreamSlice,
          ],
        ]),
      }),
    ).toMatchObject({
      ctrlCAction: 'exit',
      displaySlice: { streamId: root, status: STREAM_PHASE.WAITING },
    });
  });

  it('uses focused stream status when a stopped child stream is focused', () => {
    const rootSlice = {
      status: STREAM_PHASE.RUNNING,
    } as StreamSlice;
    const childSlice = {
      status: STREAM_PHASE.CANCELLED,
    } as StreamSlice;
    const waitingChildSlice = {
      status: STREAM_PHASE.WAITING,
    } as StreamSlice;
    const streams = new Map<StreamSlice['streamId'], StreamSlice>([
      ['root', rootSlice],
      ['child', childSlice],
      ['waiting-child', waitingChildSlice],
    ]);

    expect(
      statusBarStreamTarget({
        activeStreamId: 'child',
        canStopActiveRun: false,
        parentStream: new Map([['child', 'root']]),
        streams,
      }).displaySlice,
    ).toBe(childSlice);
    expect(
      statusBarStreamTarget({
        activeStreamId: 'waiting-child',
        canStopActiveRun: false,
        parentStream: new Map([['waiting-child', 'root']]),
        streams,
      }).displaySlice,
    ).toBe(waitingChildSlice);
    expect(
      statusBarStreamTarget({
        activeStreamId: 'root',
        canStopActiveRun: false,
        parentStream: new Map([['child', 'root']]),
        streams,
      }).displaySlice,
    ).toBe(rootSlice);
  });

  it('keeps status discoverable in narrow single-stream sessions', () => {
    const display = buildStatusBarDisplay(statusInput({ width: 50 }));

    expect(display.bindings).toBe(
      'Alt-p tasks · /status details · Ctrl-C exit',
    );
  });

  it('hides inactive global bindings while a foreground panel owns input', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        activeSubagents: 2,
        activeProcesses: 1,
        approvalDepth: 1,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        ctrlCAction: 'stop',
        shortcutsActive: false,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toContain('1 approval');
    expect(display.bindings).toBe(
      'Use foreground panel shortcuts · Esc close · Ctrl-C stop',
    );
  });

  it('labels foreground user questions as questions instead of approvals', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        approvalDepth: 1,
        approvalKind: 'question',
        foregroundEscapeAction: 'skip',
        shortcutsActive: false,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toContain('1 question');
    expect(display.left.map(statusBarSegmentText)).not.toContain('1 approval');
    expect(display.bindings).toContain('Esc skip');
  });

  it('shows cancel for non-question approval foregrounds', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        approvalDepth: 1,
        foregroundEscapeAction: 'cancel',
        shortcutsActive: false,
      }),
    );

    expect(display.bindings).toContain('Esc cancel');
  });

  it('keeps escape and Ctrl-C actions visible in narrow foreground panels', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        activeSubagents: 3,
        activeProcesses: 1,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        ctrlCAction: 'stop',
        shortcutsActive: false,
        width: 40,
      }),
    );

    expect(display.bindings).toBe('Esc close · Ctrl-C stop');
  });

  it('falls back to the bare Ctrl-C action in tiny foreground panels', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        activeSubagents: 3,
        activeProcesses: 1,
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        ctrlCAction: 'stop',
        shortcutsActive: false,
        width: 15,
      }),
    );

    expect(display.bindings).toBe('Ctrl-C stop');
  });

  it('shows a live elapsed segment only while running', () => {
    const runningInput = statusInput({
      status: STREAM_PHASE.RUNNING,
      elapsedMs: 110_000,
    });
    const running = buildStatusBarDisplay(runningInput);

    expect(running.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '1m 50s',
      PERSONAL_API_MODE_LABEL,
    ]);

    const resuming = buildStatusBarDisplay({
      ...runningInput,
      substate: STREAM_SUBSTATE.RESUMING,
    });
    expect(resuming.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'resuming',
      '1m 50s',
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

    const thinking = buildStatusBarDisplay({
      ...runningInput,
      thinkingActive: true,
    });
    expect(thinking.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      '1m 50s',
      'thinking...',
      PERSONAL_API_MODE_LABEL,
    ]);

    // The same elapsed reading is suppressed once the turn is no longer running.
    const idle = buildStatusBarDisplay(
      statusInput({ elapsedMs: 110_000, thinkingActive: true }),
    );

    expect(idle.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('preserves distinct YOLO, bash, and edit bypass badges', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        bypass: { bash: true, superYolo: true, toolEdit: true },
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
      'YOLO',
      'AUTO-BASH',
      'AUTO-EDIT',
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
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        bypass: { bash: false, superYolo: true, toolEdit: true },
        queuedFollowUpMessages: ['Keep the proof under one page.'],
        width: 65,
      }),
    );

    expect(display.right).toBe('Keep the proof…');
    expect(display.bindings).toContain('Ctrl-C exit');
  });

  it('shows the resume command while exit confirmation is armed', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        pendingExitHint: true,
        pendingExitResumeId: 'abc123',
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'Press Ctrl-C again to exit',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.bindings).toBe(
      'Resume this session with: texra resume abc123',
    );
  });

  it('uses the provided command name in the armed-exit resume command', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        pendingExitHint: true,
        pendingExitResumeId: 'abc123',
        commandName: 'texra-local',
      }),
    );

    expect(display.bindings).toBe(
      'Resume this session with: texra-local resume abc123',
    );
  });

  it('warns that queued follow-ups are discarded while exit is armed', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        pendingExitHint: true,
        pendingExitResumeId: 'abc123',
        queuedFollowUpMessages: [
          'Keep the proof under one page.',
          'Also mention the finite monoid argument.',
        ],
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toContain(
      '2 queued follow-ups will be discarded',
    );
    expect(
      display.left.find(
        (segment) =>
          statusBarSegmentText(segment) ===
          '2 queued follow-ups will be discarded',
      ),
    ).toMatchObject({ color: 'red' });
  });

  it('compacts token usage to a percentage before dropping it on narrow widths', () => {
    const input = statusInput({
      status: STREAM_PHASE.RUNNING,
      usage: { inputTokens: 80_000, outputTokens: 25_000, cost: 0 },
    });

    // Wide: the full usage segment fits.
    expect(
      buildStatusBarDisplay({ ...input, width: 80 }).left.map(
        statusBarSegmentText,
      ),
    ).toContain('80k/1.0M (8%)');

    // Narrow: the segment degrades to the bare percentage instead of
    // disappearing, keeping context pressure visible.
    const narrow = buildStatusBarDisplay({ ...input, width: 24 }).left.map(
      statusBarSegmentText,
    );
    expect(narrow).not.toContain('80k/1.0M (8%)');
    expect(narrow).toContain('8%');
  });

  it('keeps the exit confirmation visible in very narrow footers', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        pendingExitHint: true,
        pendingExitResumeId: 'abc123',
        width: 29,
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'Press Ctrl-C again to ex…',
    ]);
    expect(display.bindings).toBe(
      'Resume this session with: texra resume abc123',
    );
  });

  it('uses portable Esc labels for meta shortcuts on macOS', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        subagentControlsAvailable: true,
        sessionNavigationAvailable: true,
        shortcutModifierLabel: defaultShortcutModifierLabel('darwin'),
      }),
    );

    expect(display.bindings).toContain('Esc 1..9 focus');
    expect(display.bindings).toContain('Esc p tasks');
    expect(display.bindings).toContain('Esc s subagents');
    expect(display.bindings).not.toContain('Option-p tasks');
  });
});

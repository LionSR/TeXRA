import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  ctrlCActionForFocus,
  statusBarSegmentText,
  statusBarStreamTarget,
  type StatusBarDisplayInput,
} from '@cli/chat/tui/panes/statusBarDisplay';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { KEY_HINT_SEPARATOR } from '@cli/chat/tui/ui/KeyHints';
import {
  NO_BYPASS,
  streamAccessTarget,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';
import { AgentCategory, STREAM_PHASE, STREAM_SUBSTATE } from '@shared/schemas';

const PERSONAL_API_MODE_LABEL = shortCliApiMode('personal');
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
    childNavigationAvailable: false,
    streamFocusAvailable: false,
    model: 'deepseekT',
    modelAccess: 'personal',
    shortcutModifierLabel: 'Alt',
    ...overrides,
  };
}

describe('CLI StatusBar display model', () => {
  it('keeps a stream model and category paired for access resolution', () => {
    const session = {
      model: 'deepseekT',
      category: AgentCategory.ToolUse,
    };
    expect(
      streamAccessTarget({ model: 'gpt55', category: 'workflow' }, session),
    ).toEqual({ model: 'gpt55', category: 'workflow' });
    expect(
      streamAccessTarget({ model: undefined, category: 'workflow' }, session),
    ).toEqual({ model: 'deepseekT', category: 'workflow' });
    expect(streamAccessTarget(undefined, session)).toEqual(session);
    expect(
      streamAccessTarget({ model: undefined, category: undefined }, session),
    ).toEqual({ model: 'deepseekT', category: undefined });
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
  });

  it('keeps idle state compact and omits static agent/model names', () => {
    const display = buildStatusBarDisplay(statusInput());

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
    ]);
    expect(display.bindings).toContain('/api api');
    expect(display.bindings).toContain('/model models');
    expect(display.bindings).not.toContain('/agent agents');
    // Ctrl-J newline must be visible — the binding exists in BaseTextInput
    // (see #4399) but used to be discoverable only via source diving.
    expect(display.bindings).toContain('Ctrl-J newline');
    expect(display.bindings).not.toContain('Shift-Enter newline');
    expect(display.bindings).toContain('Ctrl-C exit');
    expect(display.bindings).not.toContain('Ctrl-C stop');
    expect(display.bindings).not.toContain('Alt-s');
    // Stream-navigation hints stay hidden in a single-stream chat.
    expect(display.bindings).not.toContain('Tab children');
    expect(display.bindings).not.toContain('Alt-1..9 focus');
    expect(display.left.map(statusBarSegmentText)).not.toContain('deepseekT');
  });

  it('renders bindings in the shared KeyHints hint format', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        transcriptAvailable: true,
        width: 80,
      }),
    );

    expect(display.bindings).toContain('Tab children');
    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).not.toContain('Alt-s subagents');
  });

  it('advertises list-owned keys while the child list has focus', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        childListFocused: true,
        childListSelectionKind: 'stream',
        childListSelectionKillable: true,
        shortcutsActive: false,
        width: 140,
      }),
    );

    expect(display.bindings).toContain('Up/Down select');
    expect(display.bindings).toContain('Enter focus');
    expect(display.bindings).toContain('v transcript');
    expect(display.bindings).toContain('k kill');
    expect(display.bindings).toContain('Tab input');
    expect(display.bindings).toContain('Esc input');
    expect(display.bindings).not.toContain('Tab children');
  });

  it('uses process-only actions for a selected process row', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        childListFocused: true,
        childListSelectionKind: 'process',
        childListSelectionKillable: true,
        childNavigationAvailable: true,
        width: 120,
      }),
    );

    expect(display.bindings).toContain('Enter details');
    expect(display.bindings).toContain('k kill');
    expect(display.bindings).not.toContain('v transcript');
  });

  it('shows foreground actions while a list-owned surface is open', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        childListFocused: true,
        childListSelectionKind: 'stream',
        childListSelectionKillable: true,
        foregroundEscapeAction: 'close',
        foregroundInputActive: true,
        shortcutsActive: false,
        width: 120,
      }),
    );

    expect(display.bindings).toContain('Esc close');
    expect(display.bindings).not.toContain('Up/Down select');
    expect(display.bindings).not.toContain('v transcript');
  });

  it('keeps the transcript shortcut in narrow stream views', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        transcriptAvailable: true,
        width: 42,
      }),
    );

    expect(display.bindings).toBe('Tab children · Ctrl-C exit');
  });

  it('advertises root agent selection while setup can still change it', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
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
        transcriptAvailable: true,
        width: 80,
      }),
    );

    expect(display.bindings).toBe(
      '/agent agents · /model models · /api api · Ctrl-C exit',
    );
  });

  it('keeps child navigation ahead of setup bindings after a root run completes', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        transcriptAvailable: true,
        width: 80,
      }),
    );

    expect(display.bindings).toContain('Tab children');
    expect(display.bindings).not.toContain('Alt-s subagents');
    expect(display.bindings).not.toContain('/model models');
    expect(display.bindings).not.toContain('/api api');
  });

  it('keeps root agent selection visible when setup bindings get narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        agentSelectionAvailable: true,
        model: 'gpt54',
        width: 50,
      }),
    );

    expect(display.bindings).toContain('/agent agents');
    expect(display.bindings).toContain('Ctrl-C exit');
    expect(display.bindings).not.toContain('/model models');
    expect(display.bindings).not.toContain('/api api');
  });

  it('does not advertise deleted picker shortcuts', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 12_000,
        modelAccess: 'included',
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop',
      }),
    );

    expect(display.bindings).toContain('/status details');
    expect(display.bindings).toContain('Ctrl-C stop');
    expect(display.bindings).not.toContain('Option-p tasks');
    expect(display.bindings).not.toContain('Option-s subagents');
  });

  it('keeps child navigation grouped with stream focus', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 12_000,
        activeSubagents: 1,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        modelAccess: 'included',
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop',
      }),
    );

    expect(display.bindings).toContain('Tab children');
    expect(display.bindings).toContain('Option-1..9 focus');
    expect(display.bindings.indexOf('Tab children')).toBeLessThan(
      display.bindings.indexOf('/status details'),
    );
    expect(display.bindings.indexOf('Option-1..9 focus')).toBeLessThan(
      display.bindings.indexOf('Ctrl-C stop'),
    );
  });

  it('does not advertise in-pane paging for focused child streams', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        activeSubagents: 1,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        modelAccess: 'included',
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop root',
        width: 100,
      }),
    );

    expect(display.bindings).not.toContain('PgUp');
    expect(display.bindings).not.toContain('scroll');
    expect(display.bindings).toContain('Tab children');
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        modelAccess: 'included',
        ctrlCAction: 'stop',
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toEqual([
      '◆',
      'running',
      'included',
      'r2',
      '80k/1.0M (8%)',
      'queued 2',
      '2 sub',
      '1 proc',
      '3 approvals',
    ]);
    expect(display.bindings).not.toContain('Alt-s subagents');
    expect(display.bindings).toContain('Ctrl-C stop');
    // Stream-navigation hints appear once more than one stream is live.
    expect(display.bindings).toContain('Tab children');
    expect(display.bindings).toContain('Alt-1..9 focus');
  });

  it('prefixes the running label with the current spin frame', () => {
    const display = buildStatusBarDisplay(
      statusInput({ status: STREAM_PHASE.RUNNING, runningFrame: '/' }),
    );

    expect(display.left.map(statusBarSegmentText)).toContain('/ running');
  });

  it('omits the spin prefix outside active phases', () => {
    const display = buildStatusBarDisplay(
      statusInput({ status: STREAM_PHASE.WAITING, runningFrame: '/' }),
    );

    expect(
      display.left.map(statusBarSegmentText).some((text) => text.includes('/')),
    ).toBe(false);
  });

  it.each(['relay', 'api-key'] as const)(
    'shows the raw registry context window for %s usage',
    (usageRoute) => {
      const display = buildStatusBarDisplay(
        statusInput({
          status: STREAM_PHASE.RUNNING,
          model: 'gpt56',
          usage: {
            inputTokens: 187_000,
            outputTokens: 4_000,
            cost: 0,
            usageRoute,
          },
        }),
      );
      expect(display.left.map(statusBarSegmentText)).toContain(
        '187k/1.1M (18%)',
      );
    },
  );

  it('caps the context window to the subscription budget for chatgpt-subscription usage', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        model: 'gpt56',
        usage: {
          inputTokens: 187_000,
          outputTokens: 4_000,
          cost: 0,
          usageRoute: 'chatgpt-subscription',
        },
      }),
    );

    // gpt-5.6's Codex subscription budget caps to 500k
    // (CODEX_GPT56_SUBSCRIPTION_CONTEXT_WINDOW), not the raw 1.05M API window.
    expect(display.left.map(statusBarSegmentText)).toContain('187k/500k (37%)');
  });

  it('uses the default 400k subscription budget for earlier Codex models', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        model: 'gpt55',
        usage: {
          inputTokens: 187_000,
          outputTokens: 4_000,
          cost: 0,
          usageRoute: 'chatgpt-subscription',
        },
      }),
    );

    expect(display.left.map(statusBarSegmentText)).toContain('187k/400k (47%)');
  });

  it('does not substitute a raw context window for unknown subscription models', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        model: 'unknown-subscription-model',
        usage: {
          inputTokens: 187_000,
          outputTokens: 4_000,
          cost: 0,
          usageRoute: 'chatgpt-subscription',
        },
      }),
    );

    const labels = display.left.map(statusBarSegmentText);
    expect(labels).toContain('187k');
    expect(labels.some((label) => label.startsWith('187k/'))).toBe(false);
  });

  it('shows the route that produced usage instead of a stale access preference', () => {
    const accessLabel = (
      usageRoute: 'chatgpt-subscription' | 'relay' | 'api-key',
    ): string[] =>
      buildStatusBarDisplay(
        statusInput({
          modelAccess: resolveCliModelAccessRoute({
            apiMode: 'personal',
            subscriptionActive: true,
            usageRoute,
          }),
          usage: {
            inputTokens: 1_000,
            outputTokens: 100,
            cost: 0,
            usageRoute,
          },
        }),
      ).left.map(statusBarSegmentText);

    expect(accessLabel('chatgpt-subscription')).toContain('subscription');
    expect(accessLabel('relay')).toContain('included');
    expect(accessLabel('relay')).not.toContain('subscription');
    expect(accessLabel('api-key')).toContain('personal');
    expect(accessLabel('api-key')).not.toContain('subscription');
  });

  it('keeps critical controls visible in narrow subagent sessions', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        activeSubagents: 3,
        activeProcesses: 1,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        ctrlCAction: 'stop',
        transcriptAvailable: true,
        width: 60,
      }),
    );

    expect(display.bindings).toBe(
      'Tab children · Ctrl-T transcript · Ctrl-C stop',
    );
    expect(display.bindings).toContain('Ctrl-C stop');
  });

  it('keeps the child list shortcut when the footer is narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        activeSubagents: 3,
        activeProcesses: 1,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        shortcutModifierLabel: 'Option',
        ctrlCAction: 'stop',
        transcriptAvailable: true,
        width: 44,
      }),
    );

    expect(display.bindings).toBe('Tab children · Ctrl-C stop');
    expect(display.bindings).not.toContain('Option-s subagents');
  });

  it('drops low-priority status details before narrow footers lose separators', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        activeSubagents: 3,
        activeProcesses: 1,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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

  it('drops the queued count segment before durable status on narrow bars', () => {
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
      childNavigationAvailable: true,
      streamFocusAvailable: true,
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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

    expect(display.bindings).toBe('/status details · Ctrl-C exit');
  });

  it('hides inactive global bindings while a foreground panel owns input', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        activeSubagents: 2,
        activeProcesses: 1,
        approvalDepth: 1,
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
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
        childNavigationAvailable: true,
        streamFocusAvailable: true,
        shortcutModifierLabel: defaultShortcutModifierLabel('darwin'),
      }),
    );

    expect(display.bindings).toContain('Esc 1..9 focus');
    expect(display.bindings).not.toContain('Esc p tasks');
    expect(display.bindings).not.toContain('Esc s subagents');
    expect(display.bindings).not.toContain('Option-p tasks');
  });
});

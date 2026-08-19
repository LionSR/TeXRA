import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  ctrlCActionForFocus,
  statusBarStreamTarget,
  subscriptionUsageProviderForStatus,
  type StatusBarDisplayInput,
} from '@cli/chat/tui/panes/statusBarDisplay';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  resolveCliModelAccessRoute,
  shortCliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import { KEY_HINT_SEPARATOR } from '@cli/tui/ui/KeyHints';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import { STREAM_PHASE, STREAM_SUBSTATE } from '@shared/schemas';

// The bar renders the short access-route label.
const INCLUDED_ACCESS_LABEL = shortCliModelAccessRoute('included');
const PERSONAL_API_MODE_LABEL = shortCliModelAccessRoute('personal');

type StatusBarDisplay = ReturnType<typeof buildStatusBarDisplay>;

function leftTexts(display: StatusBarDisplay): string[] {
  return display.left.map((segment) => segment.text);
}

// `StatusBarDisplayInput` with every field optional and its three grouped
// members individually overridable, so a test still names one field at a time
// without a flat mirror of the group members drifting alongside them.
type StatusInputOverrides = Omit<
  Partial<StatusBarDisplayInput>,
  'foreground' | 'childList' | 'shortcuts'
> & {
  readonly foreground?: Partial<StatusBarDisplayInput['foreground']>;
  readonly childList?: Partial<StatusBarDisplayInput['childList']>;
  readonly shortcuts?: Partial<StatusBarDisplayInput['shortcuts']>;
};

// Idle single-stream baseline; each test overrides only the fields it exercises.
function statusInput(
  overrides: StatusInputOverrides = {},
): StatusBarDisplayInput {
  const { foreground, childList, shortcuts, ...rest } = overrides;

  return {
    status: STREAM_PHASE.WAITING,
    transientNotice: undefined,
    bypass: NO_BYPASS,
    queuedFollowUpMessages: [],
    usage: undefined,
    contextState: undefined,
    stage: undefined,
    subagents: 0,
    runningSessions: 0,
    approvalDepth: 0,
    modelAccess: 'personal',
    ...rest,
    foreground: { ...foreground },
    childList: { ...childList },
    shortcuts: {
      chatInputAvailable: true,
      childNavigationAvailable: false,
      streamFocusAvailable: false,
      modifierLabel: 'Alt',
      ...shortcuts,
    },
  };
}

// Recurring shortcut bundles for the stream-navigation row.
const STREAM_NAV_SHORTCUTS = {
  childNavigationAvailable: true,
  streamFocusAvailable: true,
} as const;
const TRANSCRIPT_SHORTCUTS = {
  ...STREAM_NAV_SHORTCUTS,
  transcriptAvailable: true,
} as const;

// The armed-exit notice most tests exercise; the discard-warning table drops
// `resumeId` to keep its expected rows short.
const EXIT_NOTICE = {
  kind: 'exit',
  text: 'Press Ctrl-C again to exit',
  resumeId: 'abc123',
  expiresAt: 1,
} as const;

const UNKNOWN_COMMAND_NOTICE = {
  kind: 'message',
  text: 'Unknown command: /wat',
  expiresAt: 1,
} as const;

type TokenUsage = NonNullable<StatusBarDisplayInput['usage']>;
type UsageRoute = NonNullable<TokenUsage['usageRoute']>;

// One heavy usage reading reused across the context-window route tests.
function heavyUsage(usageRoute: UsageRoute): TokenUsage {
  return { inputTokens: 187_000, outputTokens: 4_000, cost: 0, usageRoute };
}

describe('CLI StatusBar display model', () => {
  it('does not show prospective plan quota after completed API-key usage', () => {
    expect(
      subscriptionUsageProviderForStatus({
        usageRoute: 'api-key',
        modelAccess: 'personal',
        prospectiveCodingPlan: 'glmCodingPlan',
      }),
    ).toBeUndefined();
    expect(
      subscriptionUsageProviderForStatus({
        usageRoute: undefined,
        modelAccess: 'personal',
        prospectiveCodingPlan: 'glmCodingPlan',
      }),
    ).toBeUndefined();
    expect(
      subscriptionUsageProviderForStatus({
        usageRoute: undefined,
        modelAccess: 'glm-code',
        prospectiveCodingPlan: 'glmCodingPlan',
      }),
    ).toBe('glmCodingPlan');
  });

  it('uses clear compact labels for API access mode', () => {
    // The session header and the status bar share one mapper, so neither can
    // print the raw enum value ('included' / 'personal') the way they once did.
    expect(shortCliModelAccessRoute('included')).toBe('Included');
    expect(shortCliModelAccessRoute('personal')).toBe('API keys');
  });

  it('keeps an ephemeral transcript warning in the durable status row', () => {
    const display = buildStatusBarDisplay(
      statusInput({ transcriptMode: 'ephemeral' }),
    );

    expect(leftTexts(display)).toContain('EPHEMERAL TRANSCRIPT');
    expect(
      display.left.find((segment) => segment.text === 'EPHEMERAL TRANSCRIPT'),
    ).toMatchObject({ badge: true, badgeColor: 'yellow' });
    expect(display.bindings).not.toContain('Resume this session');
  });

  it('surfaces non-default approval policies in the durable status row', () => {
    const input = statusInput({ approvalPolicy: 'ask' });
    const ask = buildStatusBarDisplay(input);

    expect(leftTexts(ask)).toEqual(['◆', 'idle', PERSONAL_API_MODE_LABEL]);

    const deny = buildStatusBarDisplay({
      ...input,
      approvalPolicy: 'never',
    });
    expect(leftTexts(deny)).toEqual([
      '◆',
      'idle',
      PERSONAL_API_MODE_LABEL,
      'never',
    ]);
    expect(deny.left.at(-1)).toMatchObject({ color: 'yellow' });

    const yolo = buildStatusBarDisplay({
      ...input,
      approvalPolicy: 'yolo',
    });
    expect(leftTexts(yolo)).toEqual([
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

    expect(leftTexts(display)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
      'queued 1',
    ]);
    expect(display.left.at(-1)).toMatchObject({ color: 'yellow' });
  });

  it('keeps idle state compact and omits static agent/model names', () => {
    const display = buildStatusBarDisplay(statusInput());

    expect(leftTexts(display)).toEqual(['◆', 'idle', PERSONAL_API_MODE_LABEL]);
    expect(display.bindings).toContain('/api api');
    expect(display.bindings).toContain('/model models');
    expect(display.bindings).not.toContain('/agent agents');
    // Ctrl-J newline must stay advertised: the binding lives in BaseTextInput
    // and the status row is its only discoverable surface.
    expect(display.bindings).toContain('Ctrl-J newline');
    expect(display.bindings).not.toContain('Shift-Enter newline');
    expect(display.bindings).toContain('Ctrl-C exit');
    expect(display.bindings).not.toContain('Ctrl-C stop');
    expect(display.bindings).not.toContain('Alt-s');
    // Stream-navigation hints stay hidden in a single-stream chat.
    expect(display.bindings).not.toContain('Esc parent');
    expect(display.bindings).not.toContain('Tab sessions');
    expect(display.bindings).not.toContain('Alt-1..9 focus');
    expect(leftTexts(display)).not.toContain('deepseekT');
  });

  it('renders bindings in the shared KeyHints hint format', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    // One hint vocabulary across the TUI: unbracketed `key action` pairs
    // joined by the KeyHints separator, matching every modal footer (#8199).
    expect(display.bindings).toContain(KEY_HINT_SEPARATOR);
    expect(display.bindings).not.toMatch(/[[\]]/);
  });

  it('advertises full output when the focused stream has history', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 80,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).not.toContain('Alt-s subagents');
  });

  it('names the focused nested session and its workflow phase', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        isChildStream: true,
        location: 'Survey (1/1) › Agent runtime',
        width: 80,
      }),
    );

    expect(leftTexts(display)).toContain('Survey (1/1) › Agent runtime');
  });

  it('declares the running session count as a status segment', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 80,
        runningSessions: 3,
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toContain('3 active');
    expect(display.bindings).toContain('Tab sessions');
  });

  it('prioritizes Esc parent at the narrowest width where it fits', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 12,
        shortcuts: { parentNavigationAvailable: true },
      }),
    );

    expect(display.bindings).toBe('Esc parent');
  });

  it('retains Ctrl-C beside Esc parent whenever the pair fits', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        ctrlCAction: 'stop root',
        width: 31,
        shortcuts: {
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
        },
      }),
    );

    expect(display.bindings).toBe('Esc parent · Ctrl-C stop root');
  });

  it('retains full output before dropping to the parent Ctrl-C pair', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        ctrlCAction: 'stop root',
        width: 52,
        shortcuts: {
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
          transcriptAvailable: true,
        },
      }),
    );

    expect(display.bindings).toBe(
      'Esc parent · Ctrl-T transcript · Ctrl-C stop root',
    );
  });

  it('prefers a richer transcript row in a medium-width parent view', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 80,
        shortcuts: {
          agentSelectionAvailable: true,
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
          transcriptAvailable: true,
        },
      }),
    );

    expect(display.bindings).toBe(
      'Esc parent · Tab sessions · Ctrl-T transcript · /agent agents · Ctrl-C exit',
    );
  });

  it('retains full output before compact setup controls for a parent', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 68,
        shortcuts: {
          agentSelectionAvailable: true,
          childNavigationAvailable: false,
          parentNavigationAvailable: true,
          transcriptAvailable: true,
        },
      }),
    );

    expect(display.bindings).toBe(
      'Esc parent · Ctrl-T transcript · Ctrl-C exit',
    );
  });

  it('omits Esc parent at the same bounded width without a parent', () => {
    const display = buildStatusBarDisplay(statusInput({ width: 10 }));

    expect(display.bindings).toBe('Ctrl-C exit');
    expect(display.bindings).not.toContain('Esc parent');
  });

  it('falls back to Ctrl-C when a tiny terminal cannot fit Esc parent', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 9,
        shortcuts: { parentNavigationAvailable: true },
      }),
    );

    expect(display.bindings).toBe('Ctrl-C exit');
    expect(display.bindings).not.toContain('Esc parent');
  });

  it('advertises list-owned keys while the child list has focus', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 140,
        foreground: { shortcutsActive: false },
        childList: {
          focused: true,
          selectionKillable: true,
        },
        shortcuts: {
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
          streamFocusAvailable: true,
        },
      }),
    );

    expect(display.bindings).toContain('↑/↓ select');
    expect(display.bindings).toContain('Enter focus');
    expect(display.bindings).not.toContain('i details');
    expect(display.bindings).toContain('k kill');
    expect(display.bindings).toContain('Tab input');
    expect(display.bindings).toContain('Esc input');
    expect(display.bindings).not.toContain('Esc parent');
    expect(display.bindings).not.toContain('Tab sessions');
  });

  it('prioritizes only an available child kill action at 70 columns', () => {
    const input = statusInput({
      width: 70,
      ctrlCAction: 'stop',
      foreground: { shortcutsActive: false },
      childList: {
        focused: true,
        selectionKillable: true,
      },
    });
    const display = buildStatusBarDisplay(input);

    expect(display.bindings).toBe(
      '↑/↓ select · k kill · Tab input · Esc input · Ctrl-C stop',
    );
    expect(
      buildStatusBarDisplay({
        ...input,
        childList: { focused: true, selectionKillable: false },
      }).bindings,
    ).not.toContain('k kill');
  });

  it('does not drop focus controls for a non-killable narrow selection', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 55,
        childList: {
          focused: true,
          selectionKillable: false,
        },
      }),
    );

    expect(display.bindings).toBe('Enter focus · Esc input · Ctrl-C exit');
  });

  it('shows foreground actions while a list-owned surface is open', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 120,
        foreground: {
          escapeAction: 'close',
          inputActive: true,
          shortcutsActive: false,
        },
        childList: {
          focused: true,
          selectionKillable: true,
        },
        shortcuts: { parentNavigationAvailable: true },
      }),
    );

    expect(display.bindings).toContain('Esc close');
    expect(display.bindings).not.toContain('Esc parent');
    expect(display.bindings).not.toContain('↑/↓ select');
  });

  it('keeps the full-output shortcut in narrow stream views', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 60,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).toContain('Ctrl-C exit');
  });

  it('prefers full output over stream cycling when the bar is very narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 42,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Tab sessions · Ctrl-C exit');
  });

  it('advertises root agent selection while setup can still change it', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 80,
        shortcuts: { agentSelectionAvailable: true },
      }),
    );

    expect(display.bindings).toBe(
      '/agent agents · /model models · /api api · Ctrl-J newline · Ctrl-C exit',
    );
  });

  it('does not let setup bindings hide full output when it fits', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 100,
        shortcuts: { agentSelectionAvailable: true, transcriptAvailable: true },
      }),
    );

    expect(display.bindings).toContain('Ctrl-T transcript');
    expect(display.bindings).toContain('/agent agents');
  });

  it('keeps model and API controls visible after local-command output rows', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 80,
        shortcuts: { agentSelectionAvailable: true, transcriptAvailable: true },
      }),
    );

    expect(display.bindings).toBe(
      '/agent agents · /model models · /api api · Ctrl-C exit',
    );
  });

  it('keeps child navigation ahead of setup bindings after a root run completes', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 80,
        shortcuts: {
          agentSelectionAvailable: true,
          ...TRANSCRIPT_SHORTCUTS,
        },
      }),
    );

    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).not.toContain('Alt-s subagents');
    expect(display.bindings).not.toContain('/model models');
    expect(display.bindings).not.toContain('/api api');
  });

  it('keeps root agent selection visible when setup bindings get narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        width: 50,
        shortcuts: { agentSelectionAvailable: true },
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
        ctrlCAction: 'stop',
        shortcuts: { modifierLabel: 'Option' },
      }),
    );

    expect(display.bindings).toContain('/status details');
    expect(display.bindings).toContain('Ctrl-C stop');
    expect(display.bindings).not.toContain('Option-p tasks');
    expect(display.bindings).not.toContain('Option-s subagents');
  });

  it('does not advertise composer controls when chat input is unavailable', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        ctrlCAction: 'stop root',
        shortcuts: {
          agentSelectionAvailable: true,
          chatInputAvailable: false,
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
          transcriptAvailable: true,
        },
      }),
    );

    expect(display.bindings).toBe(
      'Esc parent · Tab sessions · Ctrl-T transcript · Ctrl-C stop root',
    );
  });

  it('keeps child navigation grouped with stream focus', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 12_000,
        subagents: 1,
        modelAccess: 'included',
        ctrlCAction: 'stop',
        shortcuts: { ...STREAM_NAV_SHORTCUTS, modifierLabel: 'Option' },
      }),
    );

    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Option-1..9 focus');
    expect(display.bindings.indexOf('Tab sessions')).toBeLessThan(
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
        subagents: 1,
        modelAccess: 'included',
        ctrlCAction: 'stop root',
        width: 100,
        shortcuts: { ...STREAM_NAV_SHORTCUTS, modifierLabel: 'Option' },
      }),
    );

    expect(display.bindings).not.toContain('PgUp');
    expect(display.bindings).not.toContain('scroll');
    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Ctrl-C stop root');
    expect(leftTexts(display)).toContain('1 agent');
  });

  it('advertises Shift-Enter for newline when the Kitty protocol is active', () => {
    const display = buildStatusBarDisplay(
      statusInput({ shortcuts: { shiftEnterNewline: true } }),
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
        contextState: {
          inputTokens: 80_000,
          contextWindow: 1_000_000,
          utilizationPercent: 8,
        },
        stage: { kind: 'round', index: 1 },
        subagents: 2,
        approvalDepth: 3,
        modelAccess: 'included',
        ctrlCAction: 'stop',
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'running',
      INCLUDED_ACCESS_LABEL,
      'r2',
      '80k/1.0M (8%)',
      'queued 2',
      '2 agents',
      '3 approvals',
    ]);
    expect(display.bindings).not.toContain('Alt-s subagents');
    expect(display.bindings).toContain('Ctrl-C stop');
    // Stream-navigation hints appear once more than one stream is live.
    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Alt-1..9 focus');
  });

  it('shows the planned round total when the workflow declares one', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        stage: { kind: 'round', index: 1, total: 3 },
      }),
    );

    const segment = display.left.find((item) => item.text === 'r2/3');
    expect(segment).toBeDefined();
    // Narrow terminals degrade to the bare current round, not to nothing.
    expect(segment?.compactText).toBe('r2');
  });

  it('carries a workflow-script phase in the same stage slot', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
      }),
    );

    const segment = display.left.find((item) => item.text === 'Reduce (2/3)');
    expect(segment).toBeDefined();
    // Narrow terminals degrade to the bare current phase, not to nothing.
    expect(segment?.compactText).toBe('Reduce (2)');
  });

  it('prefixes the running label with the current spin frame', () => {
    const display = buildStatusBarDisplay(
      statusInput({ status: STREAM_PHASE.RUNNING, runningFrame: '/' }),
    );

    expect(leftTexts(display)).toContain('/ running');
  });

  it('omits the spin prefix outside active phases', () => {
    const display = buildStatusBarDisplay(
      statusInput({ status: STREAM_PHASE.WAITING, runningFrame: '/' }),
    );

    expect(leftTexts(display).some((text) => text.includes('/'))).toBe(false);
  });

  it('reports the window the model handler served, not a registry lookup', () => {
    // gpt-5.6's raw registry window is 1.05M, but a Codex-subscription turn
    // runs under a 400k budget — and a compacted turn under something else
    // again. The handler stamps what it used; the bar renders that verbatim.
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        usage: heavyUsage('chatgpt-subscription'),
        contextState: {
          inputTokens: 187_000,
          contextWindow: 400_000,
          utilizationPercent: 46.8,
        },
      }),
    );

    expect(leftTexts(display)).toContain('187k/400k (47%)');
  });

  it('shows a bare token count until the handler reports a window', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        usage: heavyUsage('chatgpt-subscription'),
      }),
    );

    const labels = leftTexts(display);
    expect(labels).toContain('187k');
    expect(labels.some((label) => label.startsWith('187k/'))).toBe(false);
  });

  it('shows the route that produced usage instead of a stale access preference', () => {
    const accessLabel = (
      usageRoute:
        | 'chatgpt-subscription'
        | 'kimi-code-subscription'
        | 'glm-coding-plan-subscription'
        | 'relay'
        | 'api-key',
    ): string[] =>
      leftTexts(
        buildStatusBarDisplay(
          statusInput({
            modelAccess: resolveCliModelAccessRoute({
              usageRoute,
              prospectiveRoute: 'chatgpt-subscription',
            }),
            usage: {
              inputTokens: 1_000,
              outputTokens: 100,
              cost: 0,
              usageRoute,
            },
          }),
        ),
      );

    expect(accessLabel('chatgpt-subscription')).toContain('subscription');
    expect(accessLabel('kimi-code-subscription')).toContain('subscription');
    expect(accessLabel('glm-coding-plan-subscription')).toContain(
      'subscription',
    );
    expect(accessLabel('relay')).toContain(INCLUDED_ACCESS_LABEL);
    expect(accessLabel('relay')).not.toContain('subscription');
    expect(accessLabel('api-key')).toContain(PERSONAL_API_MODE_LABEL);
    expect(accessLabel('api-key')).not.toContain('subscription');
  });

  it('keeps critical controls visible in narrow subagent sessions', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 60,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe(
      'Tab sessions · Ctrl-T transcript · Ctrl-C stop',
    );
  });

  it('keeps the child list shortcut when the footer is narrow', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 44,
        shortcuts: { ...TRANSCRIPT_SHORTCUTS, modifierLabel: 'Option' },
      }),
    );

    expect(display.bindings).toBe('Tab sessions · Ctrl-C stop');
    expect(display.bindings).not.toContain('Option-s subagents');
  });

  it('keeps child navigation discoverable below the combined footer width', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 88_000,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 27,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).not.toContain('3 sub');
    expect(display.bindings).toBe('Tab sessions');
  });

  it('uses the Ctrl-C-only fallback when even compact child navigation cannot fit', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 13,
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Ctrl-C stop');
  });

  it('drops low-priority status details before narrow footers lose separators', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 34,
        foreground: { shortcutsActive: false },
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'running',
      '1m 15s',
      PERSONAL_API_MODE_LABEL,
      '3 sub',
    ]);
    expect(leftTexts(display).join(' ')).not.toContain(
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

    expect(leftTexts(display)).toEqual([
      '◆',
      'running',
      '1m 15s',
      PERSONAL_API_MODE_LABEL,
    ]);
  });

  it('drops elapsed and access mode rather than overflowing the row', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        elapsedMs: 75_000,
        ctrlCAction: 'stop',
        width: 16,
      }),
    );

    // At 16 columns even `◆ running API keys` (18 cols + gaps) cannot fit —
    // the fitting sweep now removes access mode too instead of returning an
    // over-wide row that soft-wraps the 1-row status line.
    expect(leftTexts(display)).toEqual(['◆', 'running']);
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

    expect(leftTexts(display)).toEqual([
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
      ctrlCAction: 'stop root',
      shortcuts: STREAM_NAV_SHORTCUTS,
    });
    const display = buildStatusBarDisplay(baseDisplayInput);

    expect(leftTexts(display)).toEqual([
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
    expect(leftTexts(liveChildDisplay)).not.toContain('root active');

    const stoppedRootDisplay = buildStatusBarDisplay({
      ...baseDisplayInput,
      ctrlCAction: 'stop',
    });
    expect(leftTexts(stoppedRootDisplay)).not.toContain('root active');
  });

  it('shows the idle wording for a focused WAITING child and root alike', () => {
    const rootDisplay = buildStatusBarDisplay(
      statusInput({ status: STREAM_PHASE.WAITING, isChildStream: false }),
    );
    expect(leftTexts(rootDisplay)).toContain('idle');

    const childDisplay = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.WAITING,
        isChildStream: true,
        ctrlCAction: 'stop root',
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );
    expect(leftTexts(childDisplay)).toContain('idle');
  });

  it.each([
    [STREAM_PHASE.FAILED, 'error'],
    [STREAM_PHASE.CANCELLED, 'stopped'],
  ] as const)(
    'uses the canonical %s label for a focused child',
    (status, label) => {
      const display = buildStatusBarDisplay(
        statusInput({ status, isChildStream: true }),
      );

      expect(leftTexts(display)).toContain(label);
    },
  );

  // `statusBarStreamTarget` resolves three coupled outputs from one input: the
  // Ctrl-C action, which slice the footer renders, and whether that displayed
  // slice belongs to a child stream. Every case asserts all three, and asserts
  // `displaySlice` by identity so the live-ancestor fallback stays
  // distinguishable from a structurally equal slice.
  describe('statusBarStreamTarget', () => {
    function streamSlice(
      streamId: string,
      status: StreamSlice['status'],
    ): StreamSlice {
      return { streamId, status } as StreamSlice;
    }

    function streamMap(
      entries: ReadonlyArray<readonly [string, StreamSlice]>,
    ): ReadonlyMap<StreamSlice['streamId'], StreamSlice> {
      return new Map<StreamSlice['streamId'], StreamSlice>(entries);
    }

    const parentOfChild = new Map([['child', 'root']]);
    const parentOfGrandchild = new Map([
      ['child', 'root'],
      ['grandchild', 'child'],
    ]);

    const rootRunning = streamSlice('root', STREAM_PHASE.RUNNING);
    const rootPending = streamSlice('root', undefined);
    const rootWaiting = streamSlice('root', STREAM_PHASE.WAITING);
    const rootCancelled = streamSlice('root', STREAM_PHASE.CANCELLED);
    const childWaiting = streamSlice('child', STREAM_PHASE.WAITING);
    const childCancelled = streamSlice('child', STREAM_PHASE.CANCELLED);
    const grandchildCancelled = streamSlice(
      'grandchild',
      STREAM_PHASE.CANCELLED,
    );

    const liveRootTree = streamMap([
      ['root', rootRunning],
      ['child', childCancelled],
      ['grandchild', grandchildCancelled],
    ]);
    const liveRootWaitingChild = streamMap([
      ['root', rootRunning],
      ['child', childWaiting],
    ]);
    const waitingChildOnly = streamMap([['child', childWaiting]]);
    const stoppedTree = streamMap([
      ['root', rootCancelled],
      ['child', childCancelled],
    ]);

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input: Parameters<typeof statusBarStreamTarget>[0];
      readonly ctrlCAction: ReturnType<
        typeof statusBarStreamTarget
      >['ctrlCAction'];
      readonly displaySlice: StreamSlice | undefined;
      readonly isChildStream: boolean;
    }> = [
      {
        name: 'focused waiting child with nothing pending or live to stop',
        input: {
          activeStreamId: 'child',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: waitingChildOnly,
        },
        ctrlCAction: 'exit',
        displaySlice: childWaiting,
        isChildStream: true,
      },
      {
        name: 'focused root that has no slice and no live ancestor',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: waitingChildOnly,
        },
        ctrlCAction: 'exit',
        displaySlice: undefined,
        isChildStream: false,
      },
      {
        name: 'focused live root without stop capability',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: false,
          parentStream: parentOfChild,
          streams: liveRootTree,
        },
        ctrlCAction: 'exit',
        displaySlice: rootRunning,
        isChildStream: false,
      },
      {
        name: 'focused live root with stop capability',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: liveRootTree,
        },
        ctrlCAction: 'stop',
        displaySlice: rootRunning,
        isChildStream: false,
      },
      {
        name: 'focused stopped child without stop capability',
        input: {
          activeStreamId: 'child',
          canStopActiveRun: false,
          parentStream: parentOfChild,
          streams: liveRootTree,
        },
        ctrlCAction: 'exit',
        displaySlice: childCancelled,
        isChildStream: true,
      },
      {
        name: 'focused stopped child with stop capability',
        input: {
          activeStreamId: 'child',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: liveRootTree,
        },
        ctrlCAction: 'stop root',
        displaySlice: childCancelled,
        isChildStream: true,
      },
      {
        name: 'focused waiting child while the root is still live',
        input: {
          activeStreamId: 'child',
          canStopActiveRun: false,
          parentStream: parentOfChild,
          streams: liveRootWaitingChild,
        },
        ctrlCAction: 'exit',
        displaySlice: childWaiting,
        isChildStream: true,
      },
      {
        name: 'focused stopped grandchild without stop capability',
        input: {
          activeStreamId: 'grandchild',
          canStopActiveRun: false,
          parentStream: parentOfGrandchild,
          streams: liveRootTree,
        },
        ctrlCAction: 'exit',
        displaySlice: grandchildCancelled,
        isChildStream: true,
      },
      {
        name: 'focused stopped grandchild with stop capability',
        input: {
          activeStreamId: 'grandchild',
          canStopActiveRun: true,
          parentStream: parentOfGrandchild,
          streams: liveRootTree,
        },
        ctrlCAction: 'stop root',
        displaySlice: grandchildCancelled,
        isChildStream: true,
      },
      {
        name: 'no focused stream and no pending run to stop',
        input: {
          activeStreamId: undefined,
          canStopActiveRun: true,
          canStopPendingRunWithoutStream: false,
          parentStream: parentOfChild,
          streams: streamMap([]),
        },
        ctrlCAction: 'exit',
        displaySlice: undefined,
        isChildStream: false,
      },
      {
        name: 'no focused stream but a pending run that has no stream yet',
        input: {
          activeStreamId: undefined,
          canStopActiveRun: true,
          canStopPendingRunWithoutStream: true,
          parentStream: parentOfChild,
          streams: streamMap([]),
        },
        ctrlCAction: 'stop',
        displaySlice: undefined,
        isChildStream: false,
      },
      {
        name: 'focused root whose stream has not reported a phase yet',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: streamMap([['root', rootPending]]),
        },
        ctrlCAction: 'stop',
        displaySlice: rootPending,
        isChildStream: false,
      },
      {
        name: 'focused waiting root while a pending run is stoppable',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: true,
          canStopPendingRunWithoutStream: true,
          parentStream: parentOfChild,
          streams: streamMap([['root', rootWaiting]]),
        },
        ctrlCAction: 'stop',
        displaySlice: rootWaiting,
        isChildStream: false,
      },
      {
        name: 'focused waiting root without stop capability',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: false,
          parentStream: parentOfChild,
          streams: streamMap([['root', rootWaiting]]),
        },
        ctrlCAction: 'exit',
        displaySlice: rootWaiting,
        isChildStream: false,
      },
      {
        // A stale host callback must not leave the footer advertising stop
        // after the visible stream tree has already become terminal.
        name: 'stale stop capability over a fully terminal root',
        input: {
          activeStreamId: 'root',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: stoppedTree,
        },
        ctrlCAction: 'exit',
        displaySlice: rootCancelled,
        isChildStream: false,
      },
      {
        name: 'stale stop capability over a fully terminal child',
        input: {
          activeStreamId: 'child',
          canStopActiveRun: true,
          parentStream: parentOfChild,
          streams: stoppedTree,
        },
        ctrlCAction: 'exit',
        displaySlice: childCancelled,
        isChildStream: true,
      },
    ];

    it.each(cases)('$name', ({ input, ...expected }) => {
      const target = statusBarStreamTarget(input);

      expect(target.ctrlCAction).toBe(expected.ctrlCAction);
      expect(target.displaySlice).toBe(expected.displaySlice);
      expect(target.isChildStream).toBe(expected.isChildStream);
    });
  });

  it('keeps status discoverable in narrow single-stream sessions', () => {
    const display = buildStatusBarDisplay(statusInput({ width: 50 }));

    expect(display.bindings).toBe('/status details · Ctrl-C exit');
  });

  it('hides inactive global bindings while a foreground panel owns input', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        subagents: 2,
        approvalDepth: 1,
        ctrlCAction: 'stop',
        foreground: { shortcutsActive: false },
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toContain('1 approval');
    expect(display.bindings).toBe(
      'Keys go to the panel above · Esc close · Ctrl-C stop',
    );
  });

  it('labels foreground user questions as questions instead of approvals', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        approvalDepth: 1,
        approvalKind: 'question',
        foreground: { escapeAction: 'skip', shortcutsActive: false },
      }),
    );

    expect(leftTexts(display)).toContain('1 question');
    expect(leftTexts(display)).not.toContain('1 approval');
    expect(display.bindings).toContain('Esc skip');
  });

  it('shows cancel for non-question approval foregrounds', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        approvalDepth: 1,
        foreground: { escapeAction: 'cancel', shortcutsActive: false },
      }),
    );

    expect(display.bindings).toContain('Esc cancel');
  });

  it('keeps escape and Ctrl-C actions visible in narrow foreground panels', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 40,
        foreground: { shortcutsActive: false },
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Esc close · Ctrl-C stop');
  });

  it('falls back to the bare Ctrl-C action in tiny foreground panels', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 15,
        foreground: { shortcutsActive: false },
        shortcuts: STREAM_NAV_SHORTCUTS,
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

    expect(leftTexts(running)).toEqual([
      '◆',
      'running',
      '1m 50s',
      PERSONAL_API_MODE_LABEL,
    ]);

    const resuming = buildStatusBarDisplay({
      ...runningInput,
      substate: STREAM_SUBSTATE.RESUMING,
    });
    expect(leftTexts(resuming)).toEqual([
      '◆',
      'resuming',
      '1m 50s',
      PERSONAL_API_MODE_LABEL,
    ]);

    const justStarted = buildStatusBarDisplay({
      ...runningInput,
      elapsedMs: -20_000,
    });
    expect(leftTexts(justStarted)).toEqual([
      '◆',
      'running',
      '0s',
      PERSONAL_API_MODE_LABEL,
    ]);

    const thinking = buildStatusBarDisplay({
      ...runningInput,
      thinkingActive: true,
    });
    expect(leftTexts(thinking)).toEqual([
      '◆',
      'running',
      '1m 50s',
      'thinking...',
      PERSONAL_API_MODE_LABEL,
    ]);

    const compacting = buildStatusBarDisplay({
      ...runningInput,
      compactingActive: true,
      thinkingActive: true,
    });
    expect(leftTexts(compacting)).toEqual([
      '◆',
      'running',
      '1m 50s',
      'compacting...',
      PERSONAL_API_MODE_LABEL,
    ]);

    // The same elapsed reading is suppressed once the turn is no longer running.
    const idle = buildStatusBarDisplay(
      statusInput({
        compactingActive: true,
        elapsedMs: 110_000,
        thinkingActive: true,
      }),
    );

    expect(leftTexts(idle)).toEqual(['◆', 'idle', PERSONAL_API_MODE_LABEL]);
  });

  it('preserves distinct agent-task, bash, and edit bypass badges', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        bypass: { bash: true, superYolo: true, toolEdit: true },
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'running',
      PERSONAL_API_MODE_LABEL,
      'AUTO-TASK',
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
        transientNotice: EXIT_NOTICE,
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'running',
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
        transientNotice: EXIT_NOTICE,
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
        transientNotice: EXIT_NOTICE,
        queuedFollowUpMessages: [
          'Keep the proof under one page.',
          'Also mention the finite monoid argument.',
        ],
      }),
    );

    expect(leftTexts(display)).toContain(
      '2 queued follow-ups will be discarded',
    );
    expect(
      display.left.find(
        (segment) => segment.text === '2 queued follow-ups will be discarded',
      ),
    ).toMatchObject({ color: 'red' });
  });

  it('does not describe queued follow-ups as discarded for ordinary notices', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        transientNotice: {
          kind: 'message',
          text: 'Signed in successfully',
          expiresAt: 1,
        },
        queuedFollowUpMessages: ['Continue with the proof.'],
      }),
    );

    expect(leftTexts(display)).toContain('Signed in successfully');
    expect(leftTexts(display)).not.toContain(
      '1 queued follow-up will be discarded',
    );
  });

  it('keeps compact run liveness visible beside transient notices', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        runningFrame: '/',
        elapsedMs: 45_000,
        transientNotice: UNKNOWN_COMMAND_NOTICE,
        width: 20,
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'run 45s', 'Unknown…']);
  });

  it('keeps thinking status visible during transient notices', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        runningFrame: '/',
        elapsedMs: 45_000,
        thinkingActive: true,
        transientNotice: UNKNOWN_COMMAND_NOTICE,
      }),
    );

    expect(leftTexts(display)).toEqual(
      expect.arrayContaining(['/ running 45s', 'thinking...']),
    );
  });

  it.each([
    {
      name: 'keeps queued-input discard warnings ahead of status details',
      width: 80,
      expected: [
        '◆',
        'run 45s',
        'Press Ctrl-C again to exit',
        '1 queued follow-up will be discarded',
      ],
    },
    {
      name: 'bounds queued-input discard warnings in very narrow footers',
      width: 30,
      expected: ['◆', '1 queued follow-up will b…'],
    },
  ])('$name', ({ width, expected }) => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        runningFrame: '/',
        elapsedMs: 45_000,
        transientNotice: {
          kind: 'exit',
          text: 'Press Ctrl-C again to exit',
          expiresAt: 1,
        },
        queuedFollowUpMessages: ['Continue with the proof.'],
        width,
      }),
    );

    expect(leftTexts(display)).toEqual(expected);
  });

  it('compacts token usage to a percentage before dropping it on narrow widths', () => {
    const input = statusInput({
      status: STREAM_PHASE.RUNNING,
      contextState: {
        inputTokens: 80_000,
        contextWindow: 1_000_000,
        utilizationPercent: 8,
      },
    });

    // Wide: the full usage segment fits.
    expect(leftTexts(buildStatusBarDisplay({ ...input, width: 80 }))).toContain(
      '80k/1.0M (8%)',
    );

    // Narrow: the segment degrades to the bare percentage instead of
    // disappearing, keeping context pressure visible.
    const narrow = leftTexts(buildStatusBarDisplay({ ...input, width: 24 }));
    expect(narrow).not.toContain('80k/1.0M (8%)');
    expect(narrow).toContain('8%');
  });

  it('keeps the exit confirmation visible in very narrow footers', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        status: STREAM_PHASE.RUNNING,
        transientNotice: EXIT_NOTICE,
        width: 29,
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'run', 'Press Ctrl-C again t…']);
    expect(display.bindings).toBe(
      'Resume this session with: texra resume abc123',
    );
  });

  it('keeps a transient notice visible beside an ephemeral badge', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        transcriptMode: 'ephemeral',
        transientNotice: {
          kind: 'message',
          text: 'Sign-in failed; try again',
          expiresAt: 1,
        },
        width: 29,
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'Sign-in failed; try again']);
  });

  it('uses portable Esc labels for meta shortcuts on macOS', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        shortcuts: {
          ...STREAM_NAV_SHORTCUTS,
          parentNavigationAvailable: true,
          modifierLabel: defaultShortcutModifierLabel('darwin'),
        },
      }),
    );

    expect(display.bindings).toContain('Esc parent');
    expect(display.bindings).toContain('Esc 1..9 focus');
    expect(display.bindings).not.toContain('Esc p tasks');
    expect(display.bindings).not.toContain('Esc s subagents');
    expect(display.bindings).not.toContain('Option-p tasks');
  });

  it('shows the limiting coding-plan quota in the persistent status row', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        modelAccess: 'glm-code',
        subscriptionQuota: {
          state: 'available',
          provider: 'glmCodingPlan',
          providerName: 'GLM',
          planName: 'GLM Coding Plan',
          fetchedAt: 1,
          windows: [
            { name: 'five_hour', percentUsed: 42, percentRemaining: 58 },
            { name: 'monthly', percentUsed: 86, percentRemaining: 14 },
          ],
        },
      }),
    );

    expect(leftTexts(display)).toContain('GLM Coding Plan 14% left');
    expect(
      display.left.find((segment) =>
        segment.text.startsWith('GLM Coding Plan'),
      ),
    ).toMatchObject({ compactText: '14% left', color: 'yellow' });
  });

  it('does not render unavailable subscription quota as a false zero', () => {
    const display = buildStatusBarDisplay(
      statusInput({
        modelAccess: 'kimi-code',
        subscriptionQuota: {
          state: 'unavailable',
          provider: 'kimiCode',
          providerName: 'Kimi Code',
          planName: 'Kimi Code',
          fetchedAt: 1,
          windows: [],
          reason: 'request_failed',
        },
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'idle', 'subscription']);
  });
});

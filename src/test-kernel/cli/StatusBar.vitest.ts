import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  statusBarRunTarget,
  subscriptionUsageProviderForStatus,
  type BypassState,
  type StatusBarChrome,
} from '@cli/chat/tui/panes/statusBarDisplay';
import { KEY_HINT_SEPARATOR } from '@cli/tui/ui/KeyHints';
import {
  RUN_PHASE,
  type ContextStateData,
  type RunId,
  type RunPhase,
  type TokenUsageStats,
  RUN_LIFECYCLE_READY,
} from '@shared/schemas';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { OWN_API_KEYS } from '@ui/copy/modelAccess';
import { makeRunView, viewWith } from './fixtures/sessionViewFixture';

type StatusBarDisplay = ReturnType<typeof buildStatusBarDisplay>;

function leftTexts(display: StatusBarDisplay): string[] {
  return display.left.map((segment) => segment.text);
}

/**
 * The run facts a test names one at a time, beside the chrome. `renderBar`
 * states them as the `RunView` and view maps the bar reads, so each test
 * keeps naming a single field.
 */
type StatusBarCase = Omit<StatusBarChrome, 'turn'> & {
  readonly status: RunPhase;
  /** The fold's label, when a test pins one the status alone would not give. */
  readonly statusLabel?: string;
  readonly isChildRun?: boolean;
  readonly bypass?: BypassState;
  readonly queuedFollowUpMessages: readonly string[];
  readonly usage: TokenUsageStats | undefined;
  readonly contextState: ContextStateData | undefined;
  readonly flow: RunView['flow'] | undefined;
  readonly subagents: number;
  readonly turn?: StatusBarChrome['turn'] & {
    readonly thinkingActive?: boolean;
    readonly compactingActive?: boolean;
  };
};

function renderBar(input: StatusBarCase): StatusBarDisplay {
  const {
    status,
    statusLabel,
    isChildRun,
    bypass,
    queuedFollowUpMessages,
    usage,
    contextState,
    flow,
    subagents,
    turn,
    ...chrome
  } = input;
  const { thinkingActive, compactingActive, ...clock } = turn ?? {};
  const run = makeRunView({
    id: 'shown' as RunId,
    status,
    ...(statusLabel === undefined ? {} : { statusLabel }),
    parentId: isChildRun ? ('root' as RunId) : null,
    usage: usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 },
    context: contextState ?? null,
    flow: flow ?? null,
    rollup: { total: subagents, running: 0, finished: 0 },
    thinkingActive: thinkingActive ?? false,
    compactingActive: compactingActive ?? false,
  });
  const view = viewWith([run]);
  if (bypass) {
    view.policy.set(run.id, { bypasses: bypass } as never);
  }
  if (queuedFollowUpMessages.length > 0) {
    view.queuedFollowUps.set(
      run.id,
      queuedFollowUpMessages.map((text) => ({ text }) as never),
    );
  }
  return buildStatusBarDisplay(run, view, { ...chrome, turn: clock });
}

type StatusInputOverrides = Omit<
  Partial<StatusBarCase>,
  'foreground' | 'childList' | 'shortcuts' | 'turn'
> & {
  readonly foreground?: Partial<StatusBarCase['foreground']>;
  readonly childList?: Partial<StatusBarCase['childList']>;
  readonly shortcuts?: Partial<StatusBarCase['shortcuts']>;
  readonly turn?: Partial<StatusBarCase['turn']>;
};

// Idle single-stream baseline; each test overrides only the fields it exercises.
const NO_BYPASS = { bash: false, superYolo: false, toolEdit: false } as const;

function statusInput(overrides: StatusInputOverrides = {}): StatusBarCase {
  const { foreground, childList, shortcuts, turn, ...rest } = overrides;

  return {
    status: RUN_PHASE.WAITING,
    transientNotice: undefined,
    bypass: NO_BYPASS,
    queuedFollowUpMessages: [],
    usage: undefined,
    contextState: undefined,
    flow: undefined,
    subagents: 0,
    runningSessions: 0,
    approvalDepth: 0,
    modelAccess: 'api-key',
    ...rest,
    turn: { ...turn },
    foreground: { ...foreground },
    childList: { ...childList },
    shortcuts: {
      chatInputAvailable: true,
      childNavigationAvailable: false,
      ...shortcuts,
    },
  };
}

// Recurring shortcut bundles for the stream-navigation row.
const STREAM_NAV_SHORTCUTS = {
  childNavigationAvailable: true,
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
} as const;

const UNKNOWN_COMMAND_NOTICE = {
  kind: 'message',
  text: 'Unknown command: /wat',
} as const;

type TokenUsage = NonNullable<StatusBarCase['usage']>;
type UsageRoute = NonNullable<TokenUsage['usageRoute']>;

// One heavy usage reading reused across the context-window route tests.
function heavyUsage(usageRoute: UsageRoute): TokenUsage {
  return { inputTokens: 187_000, outputTokens: 4_000, cost: 0, usageRoute };
}

describe('CLI StatusBar display model', () => {
  it.each([
    {
      name: 'completed API-key usage over a prospective coding plan',
      usageRoute: 'api-key',
      prospectiveRoute: 'glm-coding-plan-subscription',
      expected: undefined,
    },
    {
      name: 'completed coding-plan usage over a prospective ChatGPT route',
      usageRoute: 'kimi-code-subscription',
      prospectiveRoute: 'chatgpt-subscription',
      expected: 'kimiCode',
    },
    {
      name: 'prospective ChatGPT route before completed usage exists',
      usageRoute: undefined,
      prospectiveRoute: 'chatgpt-subscription',
      expected: 'chatgpt',
    },
    {
      name: 'prospective coding-plan route before completed usage exists',
      usageRoute: undefined,
      prospectiveRoute: 'glm-coding-plan-subscription',
      expected: 'glmCodingPlan',
    },
    {
      name: 'prospective route without a quota provider',
      usageRoute: undefined,
      prospectiveRoute: 'xai-subscription',
      expected: undefined,
    },
  ] as const)('$name', ({ usageRoute, prospectiveRoute, expected }) => {
    expect(
      subscriptionUsageProviderForStatus({ usageRoute, prospectiveRoute }),
    ).toBe(expected);
  });

  it('surfaces non-default approval policies in the durable status row', () => {
    const input = statusInput({ approvalPolicy: 'ask' });
    const ask = renderBar(input);

    expect(leftTexts(ask)).toEqual(['◆', 'Idle']);

    const deny = renderBar({
      ...input,
      approvalPolicy: 'never',
    });
    expect(leftTexts(deny)).toEqual(['◆', 'Idle', 'never']);
    expect(deny.left.at(-1)).toMatchObject({ color: 'yellow' });

    const yolo = renderBar({
      ...input,
      approvalPolicy: 'yolo',
    });
    expect(leftTexts(yolo)).toEqual(['◆', 'Idle', 'auto-approve']);
    expect(yolo.left.at(-1)).toMatchObject({ color: 'red' });
  });

  it('keeps queued follow-up counts in the durable left status segments', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        queuedFollowUpMessages: ['Keep the proof under one page.'],
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'Running', 'queued 1']);
    expect(display.left.at(-1)).toMatchObject({ color: 'yellow' });
  });

  it('keeps idle state compact and omits static agent/model names', () => {
    const display = renderBar(statusInput());

    // Own API keys are the default route, so they earn no segment; the bar
    // names keys only, and stream-navigation hints stay hidden in a
    // single-stream chat.
    expect(leftTexts(display)).toEqual(['◆', 'Idle']);
    expect(display.bindings).toBe('/ commands · Ctrl-C exit');
  });

  it('renders bindings in the shared KeyHints hint format', () => {
    const display = renderBar(
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
    const display = renderBar(
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
    const display = renderBar(
      statusInput({
        isChildRun: true,
        location: { context: 'Survey (1/1)', label: 'Agent runtime' },
        width: 80,
      }),
    );

    expect(leftTexts(display)).toContain('Survey (1/1) › Agent runtime');
  });

  it('declares the running session count as a status segment', () => {
    const display = renderBar(
      statusInput({
        width: 80,
        runningSessions: 3,
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toContain('3 active');
    expect(display.bindings).toContain('Tab sessions');
  });

  it('keeps the session list before dropping to the parent Ctrl-C pair', () => {
    const display = renderBar(
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
      'Esc parent · Tab sessions · Ctrl-C stop root',
    );
  });

  it('prefers a richer transcript row in a medium-width parent view', () => {
    const display = renderBar(
      statusInput({
        width: 80,
        shortcuts: {
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
          transcriptAvailable: true,
        },
      }),
    );

    expect(display.bindings).toBe(
      'Esc parent · Tab sessions · Ctrl-T transcript · / commands · Ctrl-C exit',
    );
  });

  it('falls back to Ctrl-C when a tiny terminal cannot fit Esc parent', () => {
    const display = renderBar(
      statusInput({
        width: 9,
        shortcuts: { parentNavigationAvailable: true },
      }),
    );

    expect(display.bindings).toBe('Ctrl-C exit');
    expect(display.bindings).not.toContain('Esc parent');
  });

  it('advertises list-owned keys while the child list has focus', () => {
    const display = renderBar(
      statusInput({
        width: 140,
        childList: {
          focused: true,
          selectionKillable: true,
        },
        shortcuts: {
          childNavigationAvailable: true,
          parentNavigationAvailable: true,
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
      childList: {
        focused: true,
        selectionKillable: true,
      },
    });
    const display = renderBar(input);

    expect(display.bindings).toBe(
      '↑/↓ select · k kill · Tab input · Esc input · Ctrl-C stop',
    );
    expect(
      renderBar({
        ...input,
        childList: { focused: true, selectionKillable: false },
      }).bindings,
    ).not.toContain('k kill');
  });

  it('does not drop focus controls for a non-killable narrow selection', () => {
    const display = renderBar(
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
    const display = renderBar(
      statusInput({
        width: 120,
        foreground: { inputActive: true },
        childList: {
          focused: true,
          selectionKillable: true,
        },
        shortcuts: { parentNavigationAvailable: true },
      }),
    );

    // The surface above prints its own keys; the bar names only Ctrl-C.
    expect(display.bindings).toBe('Ctrl-C exit');
  });

  it('prefers full output over stream cycling when the bar is very narrow', () => {
    const display = renderBar(
      statusInput({
        width: 42,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Tab sessions · Ctrl-C exit');
  });

  it('does not advertise composer controls when chat input is unavailable', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        ctrlCAction: 'stop root',
        shortcuts: {
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

  it('does not advertise in-pane paging for focused child runs', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        subagents: 1,
        modelAccess: 'api-key',
        ctrlCAction: 'stop root',
        width: 100,
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(display.bindings).not.toContain('PgUp');
    expect(display.bindings).not.toContain('scroll');
    expect(display.bindings).toContain('Tab sessions');
    expect(display.bindings).toContain('Ctrl-C stop root');
    expect(leftTexts(display)).toContain('1 agent');
  });

  it('shows live running signals and approval depth', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        queuedFollowUpMessages: [
          'Keep the proof under one page.',
          'Also mention the finite monoid argument.',
        ],
        contextState: {
          inputTokens: 80_000,
          contextWindow: 1_000_000,
          utilizationPercent: 8,
        },
        flow: { family: 'reflection', step: 'round.begin', round: 1 },
        subagents: 2,
        approvalDepth: 3,
        modelAccess: 'api-key',
        ctrlCAction: 'stop',
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'Running',
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
  });

  it('shows a tool-use run neither its turn nor the round it never advances', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        // What the loop writes: the turn is one-based (`state.turn + 1`) and
        // the round stays at the zero it opened with.
        flow: { family: 'toolUse', step: 'turn.begin', round: 0, turn: 2 },
      }),
    );

    // A chat's turn count is not something anyone acts on.
    expect(leftTexts(display)).not.toContain('t2');
    expect(leftTexts(display)).not.toContain('r1');
  });

  it('leaves the flow slot empty until the loop reaches a coordinate', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        flow: { family: 'toolUse', step: 'waiting' },
      }),
    );

    expect(leftTexts(display).join(' ')).not.toMatch(/\b[rt]\d/);
  });

  it('reports the window the model handler served, not a registry lookup', () => {
    // gpt-5.6's raw registry window is 1.05M, but a Codex-subscription turn
    // runs under a 400k budget — and a compacted turn under something else
    // again. The handler stamps what it used; the bar renders that verbatim.
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
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
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
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
        | 'api-key',
    ): string[] =>
      leftTexts(
        renderBar(
          statusInput({
            modelAccess: usageRoute,
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
    // Own API keys are the default route: no access segment at all.
    expect(accessLabel('api-key')).not.toContain(OWN_API_KEYS.compactLabel);
    expect(accessLabel('api-key')).not.toContain('subscription');
  });

  it('keeps critical controls visible in narrow subagent sessions', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { elapsedMs: 88_000 },
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
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { elapsedMs: 88_000 },
        subagents: 3,
        ctrlCAction: 'stop',
        width: 44,
        shortcuts: TRANSCRIPT_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Tab sessions · Ctrl-C stop');
  });

  it('prioritizes Esc parent at the narrowest width where it fits', () => {
    const display = renderBar(
      statusInput({
        width: 12,
        shortcuts: { parentNavigationAvailable: true },
      }),
    );

    expect(display.bindings).toBe('Esc parent');
  });

  it('keeps child navigation discoverable below the combined footer width', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { elapsedMs: 88_000 },
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
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 13,
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Ctrl-C stop');
  });

  it('drops low-priority status details before narrow footers lose separators', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { elapsedMs: 75_000 },
        subagents: 3,
        ctrlCAction: 'stop',
        width: 34,
        foreground: { inputActive: true },
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'Running', '1m 15s', '3 agents']);
  });

  it('drops elapsed and access mode rather than overflowing the row', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { elapsedMs: 75_000 },
        ctrlCAction: 'stop',
        width: 16,
      }),
    );

    // At 16 columns the elapsed segment cannot fit either — the fitting sweep
    // removes it instead of returning an over-wide row that soft-wraps the
    // 1-row status line.
    expect(leftTexts(display)).toEqual(['◆', 'Running']);
  });

  it('drops the queued count segment before durable status on narrow bars', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { elapsedMs: 75_000 },
        queuedFollowUpMessages: ['Keep the proof under one page.'],
        approvalDepth: 3,
        ctrlCAction: 'stop',
        width: 30,
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'Running',
      '1m 15s',
      '3 approvals',
    ]);
  });

  it('labels the root as active while a child stream has focus', () => {
    // `statusBarRunTarget` resolves the 'stop root' action itself (see its
    // table below); this covers the footer it produces.
    const baseDisplayInput = statusInput({
      status: RUN_PHASE.CANCELLED,
      ctrlCAction: 'stop root',
      shortcuts: STREAM_NAV_SHORTCUTS,
    });
    const display = renderBar(baseDisplayInput);

    expect(leftTexts(display)).toEqual(['◆', 'Stopped', 'root active']);
    expect(display.bindings).toContain('Ctrl-C stop root');

    const liveChildDisplay = renderBar({
      ...baseDisplayInput,
      status: RUN_PHASE.RUNNING,
    });
    expect(leftTexts(liveChildDisplay)).not.toContain('root active');

    const stoppedRootDisplay = renderBar({
      ...baseDisplayInput,
      ctrlCAction: 'stop',
    });
    expect(leftTexts(stoppedRootDisplay)).not.toContain('root active');
  });

  it('shows the idle wording for a focused WAITING child and root alike', () => {
    const rootDisplay = renderBar(
      statusInput({ status: RUN_PHASE.WAITING, isChildRun: false }),
    );
    expect(leftTexts(rootDisplay)).toContain('Idle');

    const childDisplay = renderBar(
      statusInput({
        status: RUN_PHASE.WAITING,
        isChildRun: true,
        ctrlCAction: 'stop root',
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );
    expect(leftTexts(childDisplay)).toContain('Idle');
  });

  it.each([
    [RUN_PHASE.FAILED, 'Error'],
    [RUN_PHASE.CANCELLED, 'Stopped'],
  ] as const)(
    'uses the canonical %s label for a focused child',
    (status, label) => {
      const display = renderBar(statusInput({ status, isChildRun: true }));

      expect(leftTexts(display)).toContain(label);
    },
  );

  // `statusBarRunTarget` resolves three coupled outputs from one input: the
  // Ctrl-C action, which slice the footer renders, and whether that displayed
  // slice belongs to a child stream. Every case asserts all three.
  describe('statusBarRunTarget', () => {
    // Lifecycle phase is the fold's: a fixture states each stream's status
    // and the target reads the view it is given.
    type Status = RunView['status'];
    const rootView = (status: Status): RunView =>
      makeRunView({ id: 'root' as RunId, status });
    const childView = (status: Status): RunView =>
      makeRunView({
        id: 'child' as RunId,
        status,
        parentId: 'root' as RunId,
        ancestors: [{ id: 'root' as RunId, label: 'root' }],
      });
    const grandchildView = (status: Status): RunView =>
      makeRunView({
        id: 'grandchild' as RunId,
        status,
        parentId: 'child' as RunId,
        ancestors: [
          { id: 'root' as RunId, label: 'root' },
          { id: 'child' as RunId, label: 'child' },
        ],
      });
    const treeOf = (
      ...runs: readonly RunView[]
    ): { view: SessionView; ownedRunIds: readonly RunId[] } => ({
      view: viewWith(runs),
      ownedRunIds: runs.map((stream) => stream.id),
    });

    const liveRootTree = treeOf(
      rootView(RUN_PHASE.RUNNING),
      childView(RUN_PHASE.CANCELLED),
      grandchildView(RUN_PHASE.CANCELLED),
    );
    const liveRootWaitingChild = treeOf(
      rootView(RUN_PHASE.RUNNING),
      childView(RUN_PHASE.WAITING),
    );
    const waitingChildOnly = treeOf(childView(RUN_PHASE.WAITING));
    const stoppedTree = treeOf(
      rootView(RUN_PHASE.CANCELLED),
      childView(RUN_PHASE.CANCELLED),
    );
    const pendingRoot = treeOf(rootView(RUN_LIFECYCLE_READY));
    const waitingRoot = treeOf(rootView(RUN_PHASE.WAITING));
    const empty = treeOf();

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input: Parameters<typeof statusBarRunTarget>[0];
      readonly ctrlCAction: ReturnType<
        typeof statusBarRunTarget
      >['ctrlCAction'];
      readonly displayRunId: string | undefined;
      readonly isChildRun: boolean;
    }> = [
      {
        name: 'focused waiting child with nothing pending or live to stop',
        input: {
          activeRunId: 'child' as RunId,
          canStopActiveRun: true,
          ...waitingChildOnly,
        },
        ctrlCAction: 'exit',
        displayRunId: 'child',
        isChildRun: true,
      },
      {
        name: 'focused root that is not in the view and has no live ancestor',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: true,
          ...waitingChildOnly,
        },
        ctrlCAction: 'exit',
        displayRunId: undefined,
        isChildRun: false,
      },
      {
        name: 'focused live root without stop capability',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: false,
          ...liveRootTree,
        },
        ctrlCAction: 'exit',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        name: 'focused live root with stop capability',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: true,
          ...liveRootTree,
        },
        ctrlCAction: 'stop',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        name: 'focused stopped child without stop capability',
        input: {
          activeRunId: 'child' as RunId,
          canStopActiveRun: false,
          ...liveRootTree,
        },
        ctrlCAction: 'exit',
        displayRunId: 'child',
        isChildRun: true,
      },
      {
        name: 'focused stopped child with stop capability',
        input: {
          activeRunId: 'child' as RunId,
          canStopActiveRun: true,
          ...liveRootTree,
        },
        ctrlCAction: 'stop root',
        displayRunId: 'child',
        isChildRun: true,
      },
      {
        name: 'focused waiting child while the root is still live',
        input: {
          activeRunId: 'child' as RunId,
          canStopActiveRun: false,
          ...liveRootWaitingChild,
        },
        ctrlCAction: 'exit',
        displayRunId: 'child',
        isChildRun: true,
      },
      {
        name: 'focused stopped grandchild without stop capability',
        input: {
          activeRunId: 'grandchild' as RunId,
          canStopActiveRun: false,
          ...liveRootTree,
        },
        ctrlCAction: 'exit',
        displayRunId: 'grandchild',
        isChildRun: true,
      },
      {
        name: 'focused stopped grandchild with stop capability',
        input: {
          activeRunId: 'grandchild' as RunId,
          canStopActiveRun: true,
          ...liveRootTree,
        },
        ctrlCAction: 'stop root',
        displayRunId: 'grandchild',
        isChildRun: true,
      },
      {
        name: 'no focused stream and no pending run to stop',
        input: {
          activeRunId: undefined,
          canStopActiveRun: true,
          canStopPendingRun: false,
          ...empty,
        },
        ctrlCAction: 'exit',
        displayRunId: undefined,
        isChildRun: false,
      },
      {
        name: 'no focused stream but a pending run that has no stream yet',
        input: {
          activeRunId: undefined,
          canStopActiveRun: true,
          canStopPendingRun: true,
          ...empty,
        },
        ctrlCAction: 'stop',
        displayRunId: undefined,
        isChildRun: false,
      },
      {
        // No phase means no live producer for that stream, and no pending run
        // either: a restored tab whose phase is still being derived must not
        // offer to stop a run that is not there.
        name: 'focused root whose stream has no phase and no pending run',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: true,
          ...pendingRoot,
        },
        ctrlCAction: 'exit',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        // The pending-run capability covers the whole launch window,
        // including the part where the run's stream id exists but its phase
        // does not; never an absent phase read as live.
        name: 'focused phaseless root while a pending run is stoppable',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: true,
          canStopPendingRun: true,
          ...pendingRoot,
        },
        ctrlCAction: 'stop',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        name: 'focused waiting root while a pending run is stoppable',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: true,
          canStopPendingRun: true,
          ...waitingRoot,
        },
        ctrlCAction: 'stop',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        name: 'focused waiting root without stop capability',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: false,
          ...waitingRoot,
        },
        ctrlCAction: 'exit',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        // A stale host callback must not leave the footer advertising stop
        // after the visible stream tree has already become terminal.
        name: 'stale stop capability over a fully terminal root',
        input: {
          activeRunId: 'root' as RunId,
          canStopActiveRun: true,
          ...stoppedTree,
        },
        ctrlCAction: 'exit',
        displayRunId: 'root',
        isChildRun: false,
      },
      {
        name: 'stale stop capability over a fully terminal child',
        input: {
          activeRunId: 'child' as RunId,
          canStopActiveRun: true,
          ...stoppedTree,
        },
        ctrlCAction: 'exit',
        displayRunId: 'child',
        isChildRun: true,
      },
    ];
    it.each(cases)('$name', ({ input, ...expected }) => {
      const target = statusBarRunTarget(input);
      expect(target.ctrlCAction).toBe(expected.ctrlCAction);
      expect(target.displayRunId).toBe(expected.displayRunId);
      expect(target.isChildRun).toBe(expected.isChildRun);
    });
  });

  it('keeps commands discoverable in narrow single-stream sessions', () => {
    const display = renderBar(statusInput({ width: 50 }));

    expect(display.bindings).toBe('/ commands · Ctrl-C exit');
  });

  it('hides inactive global bindings while a foreground panel owns input', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        subagents: 2,
        approvalDepth: 1,
        ctrlCAction: 'stop',
        foreground: { inputActive: true },
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(leftTexts(display)).toContain('1 approval');
    expect(display.bindings).toBe('Ctrl-C stop');
  });

  it('labels foreground user questions as questions instead of approvals', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        approvalDepth: 1,
        approvalKind: 'question',
        foreground: { inputActive: true },
      }),
    );

    expect(leftTexts(display)).toContain('1 question');
    expect(leftTexts(display)).not.toContain('1 approval');
  });

  it('falls back to the bare Ctrl-C action in tiny foreground panels', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        subagents: 3,
        ctrlCAction: 'stop',
        width: 15,
        foreground: { inputActive: true },
        shortcuts: STREAM_NAV_SHORTCUTS,
      }),
    );

    expect(display.bindings).toBe('Ctrl-C stop');
  });

  it('shows a live elapsed segment only while running', () => {
    const runningInput = statusInput({
      status: RUN_PHASE.RUNNING,
      turn: { elapsedMs: 110_000 },
    });
    const running = renderBar(runningInput);

    expect(leftTexts(running)).toEqual(['◆', 'Running', '1m 50s']);

    const resuming = renderBar({
      ...runningInput,
      statusLabel: 'Resuming',
    });
    expect(leftTexts(resuming)).toEqual(['◆', 'Resuming', '1m 50s']);

    const justStarted = renderBar({
      ...runningInput,
      turn: { ...runningInput.turn, elapsedMs: -20_000 },
    });
    expect(leftTexts(justStarted)).toEqual(['◆', 'Running', '0s']);

    const thinking = renderBar({
      ...runningInput,
      turn: { ...runningInput.turn, thinkingActive: true },
    });
    expect(leftTexts(thinking)).toEqual([
      '◆',
      'Running',
      '1m 50s',
      'thinking...',
    ]);

    const compacting = renderBar({
      ...runningInput,
      turn: {
        ...runningInput.turn,
        compactingActive: true,
        thinkingActive: true,
      },
    });
    expect(leftTexts(compacting)).toEqual([
      '◆',
      'Running',
      '1m 50s',
      'compacting...',
    ]);

    // The same elapsed reading is suppressed once the turn is no longer running.
    const idle = renderBar(
      statusInput({
        turn: {
          compactingActive: true,
          elapsedMs: 110_000,
          thinkingActive: true,
        },
      }),
    );

    expect(leftTexts(idle)).toEqual(['◆', 'Idle']);
  });

  it('preserves distinct agent-task, bash, and edit bypass badges', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        bypass: { bash: true, superYolo: true, toolEdit: true },
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'Running',
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
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        transientNotice: EXIT_NOTICE,
      }),
    );

    expect(leftTexts(display)).toEqual([
      '◆',
      'Running',
      'Press Ctrl-C again to exit',
    ]);
    expect(display.bindings).toBe(
      'Resume this session with: texra resume abc123',
    );
  });

  it('uses the provided command name in the armed-exit resume command', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        transientNotice: EXIT_NOTICE,
        commandName: 'texra-local',
      }),
    );

    expect(display.bindings).toBe(
      'Resume this session with: texra-local resume abc123',
    );
  });

  it('warns that queued follow-ups are discarded while exit is armed', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
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
    const display = renderBar(
      statusInput({
        transientNotice: {
          kind: 'message',
          text: 'Signed in successfully',
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
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { runningFrame: '/', elapsedMs: 45_000 },
        transientNotice: UNKNOWN_COMMAND_NOTICE,
        width: 20,
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'run 45s', 'Unknown…']);
  });

  it('keeps thinking status visible during transient notices', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        turn: { runningFrame: '/', elapsedMs: 45_000, thinkingActive: true },
        transientNotice: UNKNOWN_COMMAND_NOTICE,
      }),
    );

    expect(leftTexts(display)).toEqual(
      expect.arrayContaining(['/ Running 45s', 'thinking...']),
    );
  });

  it.each([
    {
      name: 'keeps queued-input discard warnings ahead of status details',
      width: 80,
      bypass: NO_BYPASS,
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
      bypass: NO_BYPASS,
      expected: ['◆', '1 queued follow-up will b…'],
    },
    {
      name: 'drops bypass badges before truncating queued-input discard warnings',
      width: 30,
      bypass: { bash: true, superYolo: true, toolEdit: true },
      expected: ['◆', '1 queued follow-up will b…'],
    },
  ])('$name', ({ width, bypass, expected }) => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        bypass,
        turn: { runningFrame: '/', elapsedMs: 45_000 },
        transientNotice: {
          kind: 'exit',
          text: 'Press Ctrl-C again to exit',
        },
        queuedFollowUpMessages: ['Continue with the proof.'],
        width,
      }),
    );

    expect(leftTexts(display)).toEqual(expected);
  });

  it('compacts token usage to a percentage before dropping it on narrow widths', () => {
    const input = statusInput({
      status: RUN_PHASE.RUNNING,
      contextState: {
        inputTokens: 80_000,
        contextWindow: 1_000_000,
        utilizationPercent: 8,
      },
    });

    // Wide: the full usage segment fits.
    expect(leftTexts(renderBar({ ...input, width: 80 }))).toContain(
      '80k/1.0M (8%)',
    );

    // Narrow: the segment degrades to the bare percentage instead of
    // disappearing, keeping context pressure visible.
    const narrow = leftTexts(renderBar({ ...input, width: 24 }));
    expect(narrow).not.toContain('80k/1.0M (8%)');
    expect(narrow).toContain('8%');
  });

  it('keeps the exit confirmation visible in very narrow footers', () => {
    const display = renderBar(
      statusInput({
        status: RUN_PHASE.RUNNING,
        transientNotice: EXIT_NOTICE,
        width: 29,
      }),
    );

    expect(leftTexts(display)).toEqual(['◆', 'run', 'Press Ctrl-C again t…']);
    expect(display.bindings).toBe(
      'Resume this session with: texra resume abc123',
    );
  });

  it('shows the limiting coding-plan quota in the persistent status row', () => {
    const display = renderBar(
      statusInput({
        modelAccess: 'glm-coding-plan-subscription',
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
    const display = renderBar(
      statusInput({
        modelAccess: 'kimi-code-subscription',
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

    expect(leftTexts(display)).toEqual(['◆', 'Idle', 'subscription']);
  });
});

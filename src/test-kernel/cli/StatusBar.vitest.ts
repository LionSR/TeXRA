import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  statusBarRunTarget,
  subscriptionUsageProviderForStatus,
  type BypassState,
  type StatusBarChrome,
} from '@cli/chat/tui/panes/statusBarDisplay';
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

// The armed-exit notice most tests exercise; the discard-warning table drops
// `resumeId` to keep its expected rows short.
const EXIT_NOTICE = {
  kind: 'exit',
  text: 'Press Ctrl-C again to exit',
  resumeId: 'abc123',
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

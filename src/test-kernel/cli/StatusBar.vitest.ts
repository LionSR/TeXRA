import { describe, expect, it } from 'vitest';

import {
  buildStatusBarDisplay,
  statusBarRunTarget,
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
  readonly isChildRun?: boolean;
  readonly bypass?: BypassState;
  readonly queuedFollowUpMessages: readonly string[];
  readonly usage: TokenUsageStats | undefined;
  readonly contextState: ContextStateData | undefined;
  readonly runTurn: RunView['turn'] | undefined;
  readonly subagents: number;
  readonly turn?: StatusBarChrome['turn'] & {
    readonly thinkingActive?: boolean;
    readonly compactingActive?: boolean;
  };
};

function renderBar(input: StatusBarCase): StatusBarDisplay {
  const {
    status,
    isChildRun,
    bypass,
    queuedFollowUpMessages,
    usage,
    contextState,
    runTurn,
    subagents,
    turn,
    ...chrome
  } = input;
  const { thinkingActive, compactingActive, ...clock } = turn ?? {};
  const run = makeRunView({
    id: 'shown' as RunId,
    status,
    parentId: isChildRun ? ('root' as RunId) : null,
    usage: usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 },
    context: contextState ?? null,
    turn: runTurn ?? null,
    rollup: { total: subagents, running: 0, finished: 0 },
    thinkingActive: thinkingActive ?? false,
    compactingActive: compactingActive ?? false,
  });
  let view = viewWith([run]);
  if (bypass) {
    view = {
      ...view,
      policy: new Map(view.policy).set(run.id, {
        own: Object.fromEntries(
          Object.entries(bypass).map(([kind, on]) => [kind, on ? 'on' : 'off']),
        ),
        goal: [],
      }),
    };
  }
  if (queuedFollowUpMessages.length > 0) {
    view = {
      ...view,
      queuedFollowUps: new Map(view.queuedFollowUps).set(
        run.id,
        queuedFollowUpMessages.map((text) => ({ text }) as never),
      ),
    };
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
    runTurn: undefined,
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

describe('CLI StatusBar display model', () => {
  it('surfaces non-default approval policies in the durable status row', () => {
    const input = statusInput({ approvalPolicy: 'ask' });
    const ask = renderBar(input);

    expect(leftTexts(ask)).toEqual(['◆', 'Idle']);

    const deny = renderBar({
      ...input,
      approvalPolicy: 'never',
    });
    expect(leftTexts(deny)).toEqual(['◆', 'Idle', 'Block']);
    expect(deny.left.at(-1)).toMatchObject({ color: 'yellow' });

    const yolo = renderBar({
      ...input,
      approvalPolicy: 'yolo',
    });
    expect(leftTexts(yolo)).toEqual(['◆', 'Idle', 'Auto-approve']);
    expect(yolo.left.at(-1)).toMatchObject({ color: 'red' });
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
});

import { it } from '@effect/vitest';
import { Clock, Effect, Exit, Queue, Scope, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect } from 'vitest';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  createRunProgressRenderer,
  shouldRenderRunProgress,
  type RunProgressRenderer,
  type RunProgressRendererInit,
} from '@cli/runtime/runProgressRenderer';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import { textDisplayWidth } from '@cli/runtime/terminalText';
import type { CliContext } from '@cli/runtime/cliContext';
import {
  aggregateId as qualifyAggregateId,
  RUN_PHASE,
  type RunId,
  type RunIdentity,
  type RunPhase,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { makeRunView, viewWith } from './fixtures/sessionViewFixture';

type ConversationProgress = RunView['conversationProgress'];

/** The catalog the renderer is built over: named by the caller, as production
 *  names the process catalog, so no suite has to replace `@agent/index`. */

function context(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    mode: 'interactive',
    renderRunProgress: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    ...overrides,
  });
}

type RuntimePresentationNdjsonPolicy =
  | {
      readonly kind: 'log';
      readonly level: 'error' | 'info';
      readonly message: string;
      readonly fields: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'suppressed' };

type RuntimePresentationNdjsonCases = {
  [K in RuntimePresentationEvent]: {
    readonly payload: RuntimePresentationEventPayloads[K];
    readonly policy: RuntimePresentationNdjsonPolicy;
  };
};

const RUNTIME_PRESENTATION_NDJSON_CASES = {
  requestShowError: {
    payload: { message: 'Provider returned 500.' },
    policy: {
      kind: 'log',
      level: 'error',
      message: 'Provider returned 500.',
      fields: {},
    },
  },
  requestShowInstruction: {
    payload: {
      key: 'latex-compile-failed',
      message: 'Inspect the log before retrying.',
      actions: ['open-configuration-guide'],
      showSuppress: true,
    },
    policy: {
      kind: 'log',
      level: 'info',
      message: 'Inspect the log before retrying.',
      fields: {
        key: 'latex-compile-failed',
        actions: ['open-configuration-guide'],
        showSuppress: true,
      },
    },
  },
  requestOpenFile: {
    payload: {
      location: { kind: 'external', absolutePath: '/tmp/paper.tex' },
      preserveFocus: false,
    },
    policy: { kind: 'suppressed' },
  },
  showAgentConfigBanner: {
    payload: { agentName: 'polish' },
    policy: {
      kind: 'log',
      level: 'error',
      message:
        'Agent not found: polish. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team.',
      fields: {},
    },
  },
  requestEnsureProgressView: {
    payload: {},
    policy: { kind: 'suppressed' },
  },
} satisfies RuntimePresentationNdjsonCases;

// context() always sets renderRunProgress: true, so the factory never
// returns undefined inside these helpers. Facts reach the renderer the way
// they do in production: as the session view the fold publishes, so each
// helper states the stream fields the fold would state and settles the ref.
type TestRunProgressRenderer = RunProgressRenderer & {
  readonly runs: Map<RunId, RunView>;
  set(runId: string, over: Partial<RunView>): Promise<void>;
  setMany(
    entries: ReadonlyArray<readonly [string, Partial<RunView>]>,
  ): Promise<void>;
};
let createdAt = 0;
const rendererScopes: Scope.Closeable[] = [];
afterEach(() =>
  Effect.runPromise(
    Effect.all(
      rendererScopes.splice(0).map((scope) => Scope.close(scope, Exit.void)),
    ),
  ),
);
/** Let the renderer's fiber observe the latest view before a case reads
 *  the output: a few turns of the event loop cover the stream pipeline. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
/** A followed session over a bare view: the renderer reads only its level
 *  and its changes. */
const followed = (ref: SubscriptionRef.SubscriptionRef<SessionView>) => ({
  view: { ref, changes: SubscriptionRef.changes(ref) },
});

function attached(renderer: RunProgressRenderer): TestRunProgressRenderer {
  const runs = new Map<RunId, RunView>();
  const ref = Effect.runSync(SubscriptionRef.make<SessionView>(viewWith([])));
  const scope = Scope.makeUnsafe();
  rendererScopes.push(scope);
  Effect.runSync(renderer.attach(followed(ref)).pipe(Scope.provide(scope)));
  const setMany = async (
    entries: ReadonlyArray<readonly [string, Partial<RunView>]>,
  ): Promise<void> => {
    for (const [runId, over] of entries) {
      const id = runId as RunId;
      const current = runs.get(id);
      runs.set(
        id,
        makeRunView({
          // The label, tone, and group follow the merged status.
          ...(current
            ? (({ statusLabel, tone, group, ...rest }) => rest)(current)
            : { createdAt: (createdAt += 1) }),
          ...over,
          id,
        } as Parameters<typeof makeRunView>[0]) as RunView,
      );
    }
    await Effect.runPromise(
      SubscriptionRef.set(ref, viewWith([...runs.values()])),
    );
    await settle();
  };
  return Object.assign(renderer, {
    runs,
    set: (runId: string, over: Partial<RunView>) => setMany([[runId, over]]),
    setMany,
  });
}
type RunConfigOverrides = {
  runId?: string;
  agent?: string;
  inputFiles?: string[];
};
/** A child the fold holds under its parent, as these cases name one. */
type ChildRow = {
  readonly childRunId: RunId;
  readonly agentName: string;
  readonly identity: RunIdentity;
  readonly status?: RunPhase;
};
function subagentChild(overrides: Partial<ChildRow> = {}): ChildRow {
  return {
    childRunId: 'child-stream' as RunId,
    agentName: 'review',
    identity: { kind: 'agent', agent: 'review' },
    status: 'running',
    ...overrides,
  };
}
/**
 * A run reaches the renderer the way a live one does: its `run.start` facts
 * (agent, inputs) with the RUNNING transition that follows.
 */
async function handleRunConfig(
  renderer: TestRunProgressRenderer,
  overrides: RunConfigOverrides = {},
): Promise<void> {
  const agent = overrides.agent ?? 'polish';
  await renderer.set(overrides.runId ?? 'stream-1', {
    identity: { kind: 'agent', agent },
    label: agent,
    inputFiles: overrides.inputFiles ?? ['paper.tex'],
    status: RUN_PHASE.RUNNING,
  } as Partial<RunView>);
}
/** Input-less root run the heartbeat and live-line cases below all start from. */
async function handleOrchestratorRootRun(
  renderer: TestRunProgressRenderer,
): Promise<void> {
  await handleRunConfig(renderer, {
    runId: 'root-stream',
    agent: 'orchestrator',
    inputFiles: [],
  });
}
/** A run's one-based turn as the fold states it (`RunView.turn`). */
async function handleTurn(
  renderer: TestRunProgressRenderer,
  runId: string,
  turn: number,
): Promise<void> {
  await renderer.set(runId, { turn });
}
async function handleConversationProgress(
  renderer: TestRunProgressRenderer,
  runId: string,
  progress: ConversationProgress,
): Promise<void> {
  await renderer.set(runId, { conversationProgress: progress });
}
async function handleRunStatus(
  renderer: TestRunProgressRenderer,
  runId: string,
  status: RunPhase,
): Promise<void> {
  await renderer.set(runId, { status });
}
async function handleRunDescription(
  renderer: TestRunProgressRenderer,
  runId: string,
  description: string,
): Promise<void> {
  await renderer.set(runId, { description });
}
/** The parent's child list as the fold states it, in one view: each named
 *  child is a live child stream, and a child that left the child list has
 *  finished. An unnamed entry has no stream to show. */
async function handleActiveSubagents(
  renderer: TestRunProgressRenderer,
  parentRunId: string,
  children: readonly ChildRow[],
): Promise<void> {
  const parent = parentRunId as RunId;
  const named = children.filter((child) => child.agentName);
  const listed = new Set(named.map((child) => child.childRunId));
  const entries: Array<readonly [string, Partial<RunView>]> = [];
  for (const [id, stream] of renderer.runs) {
    if (stream.parentId === parent && !listed.has(id)) {
      entries.push([id, { status: RUN_PHASE.COMPLETED }]);
    }
  }
  for (const child of named) {
    entries.push([
      child.childRunId,
      {
        parentId: parent,
        ancestors: [{ id: parent, label: parent }],
        label: child.agentName,
        identity: child.identity,
        status:
          child.status === 'running'
            ? RUN_PHASE.RUNNING
            : (child.status ?? RUN_PHASE.WAITING),
      },
    ]);
  }
  await renderer.setMany(entries);
}
/** A run on a real session: its `run.start`, the config the fold reads the
 *  inputs from, and the RUNNING transition, then the fold's own settle. */
function publishRun(
  session: SessionHandle,
  overrides: RunConfigOverrides = {},
): Effect.Effect<void> {
  const runId = (overrides.runId ?? 'e5e5e5') as RunId;
  const agent = overrides.agent ?? 'polish';
  publishTestRows(session, [
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', runId),
      identity: { kind: 'agent', agent },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      worktree: null,
      parent: null,
      provenance: null,
      approvalPolicy: null,
    },
  ]);
  publishTestRows(session, [
    {
      type: 'run.config',
      aggregateId: qualifyAggregateId('run', runId),
      config: AgentConfigSchema.parse({
        agent,
        model: 'deepseek/deepseek-v4-flash',
        inputFiles: overrides.inputFiles ?? ['paper.tex'],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
        editedFile: null,
        toolConfig: {
          autoExtractFigure: false,
          autoExtractTikzFigure: false,
          attachTeXCount: false,
          autoCompileInputPdf: false,
        },
        memories: [],
        instruction: '',
        workingDirectory: '/tmp/project',
      }),
    },
  ]);
  publishTestRows(session, [
    {
      type: 'run.activate',
      aggregateId: qualifyAggregateId('run', runId),
    },
    // The first step of the loop: what clears the activation's starting
    // substate, so the live line reads the plain running phase. A workflow
    // run's first turn is its first round.
    {
      type: 'run.position',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
    },
  ]);
  return Effect.promise(() => settle());
}
function outputBuffer(): { write: (chunk: string) => void; text: string } {
  const buffer = {
    text: '',
    write: (chunk: string) => {
      buffer.text += chunk;
    },
  };
  return buffer;
}

function plainRenderer(
  output: ReturnType<typeof outputBuffer>,
  init: Partial<RunProgressRendererInit> = {},
): TestRunProgressRenderer {
  return attached(
    createRunProgressRenderer(context({ stderrColorEnabled: false }), {
      colorEnabled: false,
      write: output.write,
      nowMs: () => 0,
      // Every view change paints: the cases pin the line, not the throttle.
      minIntervalMs: 0,
      ...init,
    })!,
  );
}

function ansiRenderer(
  output: ReturnType<typeof outputBuffer>,
  init: Partial<RunProgressRendererInit> = {},
): TestRunProgressRenderer {
  return attached(
    createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: output.write,
      nowMs: () => 0,
      minIntervalMs: 0,
      ...init,
    })!,
  );
}

function captureStreamWrites<E, R>(
  stream: NodeJS.WriteStream,
  action: Effect.Effect<unknown, E, R>,
): Effect.Effect<string, E, R> {
  const capture = { output: '' };
  const originalWrite = stream.write;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        capture.output += decodeStreamChunk(chunk, args);
        const callback = args.find(
          (arg): arg is (error?: Error | null) => void =>
            typeof arg === 'function',
        );
        callback?.();
        return true;
      }) as typeof stream.write;
    }),
    () => action,
    () =>
      Effect.sync(() => {
        stream.write = originalWrite;
      }),
  ).pipe(Effect.map(() => capture.output));
}

function ndjsonRecords(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function decodeStreamChunk(
  chunk: string | Uint8Array,
  args: unknown[],
): string {
  if (typeof chunk === 'string') return chunk;

  const encoding = args.find(
    (arg): arg is BufferEncoding => typeof arg === 'string',
  );
  return Buffer.from(chunk).toString(encoding);
}

describe('CLI run progress renderer', () => {
  it('renders a single ANSI status line and clears it on close', async () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { nowMs: () => now });

    await handleRunConfig(renderer);
    expect(output.text).toBe('\r\x1b[2Kpolish paper.tex · 0s');

    now = 1200;
    await handleTurn(renderer, 'stream-1', 2);
    expect(output.text).toContain('\r\x1b[2K[t2] · polish paper.tex · 1s');

    renderer.clear();
    expect(output.text.endsWith('\r\x1b[2K')).toBe(true);
  });

  it.effect('ticks the ANSI status line while a root workflow is quiet', () =>
    Effect.gen(function* () {
      const root = {
        id: 'stream-1' as RunId,
        label: 'polish',
        inputFiles: ['paper.tex'],
      };
      const clock = yield* Clock.Clock;
      const writes = yield* Queue.unbounded<string>();
      const output = outputBuffer();
      const renderer = createRunProgressRenderer(context(), {
        colorEnabled: true,
        nowMs: () => clock.currentTimeMillisUnsafe(),
        minIntervalMs: 0,
        write: (text) => {
          output.write(text);
          Queue.offerUnsafe(writes, text);
        },
      })!;
      const view = yield* SubscriptionRef.make(viewWith([makeRunView(root)]));
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* renderer
        .attach(followed(view), { runId: root.id })
        .pipe(Scope.provide(scope));
      yield* Queue.take(writes);
      const initial = '\r\x1b[2Kpolish paper.tex · 0s';
      expect(output.text).toBe(initial);
      yield* TestClock.adjust('999 millis');
      expect(output.text).toBe(initial);
      yield* TestClock.adjust('1 millis');
      expect(yield* Queue.take(writes)).toBe('\r\x1b[2Kpolish paper.tex · 1s');
      yield* TestClock.adjust('1300 millis');
      expect(yield* Queue.take(writes)).toBe('\r\x1b[2Kpolish paper.tex · 2s');

      renderer.preserve();
      expect(yield* Queue.take(writes)).toBe('\n');
      const preserved = output.text;
      yield* TestClock.adjust('1 second');
      expect(output.text).toBe(preserved);
      yield* SubscriptionRef.set(
        view,
        viewWith([makeRunView({ ...root, turn: 2 })]),
      );
      expect(yield* Queue.take(writes)).toContain('[t2]');
      yield* TestClock.adjust('1 second');
      expect(yield* Queue.take(writes)).toContain('4s');
      renderer.clear();
      expect(yield* Queue.take(writes)).toBe('\r\x1b[2K');
      const cleared = output.text;
      yield* TestClock.adjust('1 second');
      expect(output.text).toBe(cleared);
      yield* SubscriptionRef.set(
        view,
        viewWith([makeRunView({ ...root, turn: 3 })]),
      );
      expect(yield* Queue.take(writes)).toContain('[t3]');
      yield* Scope.close(scope, Exit.void);
      const closed = output.text;
      yield* TestClock.adjust('1 second');
      expect(output.text).toBe(closed);
    }),
  );

  it('renders the live line from direct session and run facts', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });
    const runId = 'stream-1';

    await handleRunConfig(renderer, { runId });
    await handleConversationProgress(renderer, runId, { toolCallCount: 3 });
    await handleTurn(renderer, runId, 1);
    await handleRunDescription(renderer, runId, 'drafting');
    await handleActiveSubagents(renderer, runId, [subagentChild()]);
    await handleRunStatus(renderer, runId, RUN_PHASE.COMPLETED);

    expect(output.text).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · tools: 3 · 0s\n' +
        '[t1] · polish paper.tex · tools: 3 · 0s\n' +
        '[t1] · polish paper.tex · drafting · tools: 3 · 0s\n' +
        '[t1] · polish paper.tex · drafting · agent: review · 0s\n' +
        '[t1] · polish paper.tex · Completed · tools: 3 · 0s\n',
    );
  });

  it('keeps the root run visible when child runs update progress', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleRunConfig(renderer, {
      runId: 'root-stream',
      agent: 'coordinator',
      inputFiles: ['main.tex'],
    });
    await handleRunConfig(renderer, {
      runId: 'child-stream',
      agent: 'reviewer',
      inputFiles: ['chapter.tex'],
    });
    await handleRunDescription(
      renderer,
      'child-stream',
      'reviewing chapter.tex',
    );
    await handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({ agentName: 'reviewer' }),
      subagentChild({
        childRunId: 'child-stream-2' as RunId,
        agentName: 'compiler',
      }),
      subagentChild({
        childRunId: 'child-stream-3' as RunId,
        agentName: 'proofreader',
      }),
    ]);

    // The newest child leads the summary: `childIds` is the fold's
    // `runOrdering` (newest creation first).
    expect(output.text).toBe(
      'coordinator main.tex · 0s\n' +
        'coordinator main.tex · agents: proofreader +2 · 0s\n',
    );
  });

  it('keeps the claimed root stream when a child run.config arrives later', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleConversationProgress(renderer, 'root-stream', {
      toolCallCount: 4,
    });
    await handleTurn(renderer, 'root-stream', 2);
    await handleRunConfig(renderer, {
      runId: 'child-stream',
      agent: 'reviewer',
      inputFiles: ['chapter.tex'],
    });

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · tools: 4 · 0s\n' +
        '[t2] · orchestrator · tools: 4 · 0s\n',
    );
  });

  it('joins a child description emitted before the active child list', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleRunDescription(
      renderer,
      'child-stream',
      'Check multiplier\nsigns\tand \x1b[2Jresonance counterexamples',
    );
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · agent: review — Check multiplier signs and resonance counterexa… · 0s\n',
    );
  });

  it('keeps the current task across a same-turn manual retry', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleRunDescription(renderer, 'child-stream', 'Current review task');
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    await handleRunStatus(renderer, 'child-stream', RUN_PHASE.WAITING);
    await handleRunStatus(renderer, 'child-stream', RUN_PHASE.RUNNING);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · agent: review — Current review task · 0s\n',
    );
  });

  it('prefers a running child over an earlier waiting child', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output);

    await handleOrchestratorRootRun(renderer);
    await handleRunDescription(renderer, 'waiting-child', 'Idle review task');
    await handleRunDescription(renderer, 'running-child', 'Active review task');
    await handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        childRunId: 'waiting-child' as RunId,
        status: RUN_PHASE.WAITING,
      }),
      subagentChild({
        childRunId: 'running-child' as RunId,
        status: RUN_PHASE.RUNNING,
      }),
    ]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · agents: review — Active review task +1 · 0s\n',
    );
  });

  it('fits the delegated task within an ANSI terminal row', async () => {
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { getColumns: () => 80 });

    await handleOrchestratorRootRun(renderer);
    await handleRunDescription(renderer, 'child-stream', 'A'.repeat(100));
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    const renderedLines = output.text.split('\r\x1b[2K').filter(Boolean);
    expect(renderedLines).toHaveLength(2);
    expect(renderedLines.at(-1)).toContain('agent: review — ');
    expect(renderedLines.every((line) => textDisplayWidth(line) <= 80)).toBe(
      true,
    );
  });

  it('recalculates the delegated task width after a terminal resize', async () => {
    let columns = 100;
    const output = outputBuffer();
    const renderer = ansiRenderer(output, { getColumns: () => columns });

    await handleOrchestratorRootRun(renderer);
    await handleRunDescription(renderer, 'child-stream', 'A'.repeat(100));
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    columns = 60;
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);

    const renderedLines = output.text.split('\r\x1b[2K').filter(Boolean);
    expect(renderedLines).toHaveLength(3);
    expect(textDisplayWidth(renderedLines.at(-1) ?? '')).toBeLessThanOrEqual(
      60,
    );
  });

  it('shows completed terminal stream stops with the shared cli wording', async () => {
    let now = 0;
    const output = outputBuffer();
    const renderer = plainRenderer(output, {
      minIntervalMs: 0,
      nowMs: () => now,
    });

    await handleOrchestratorRootRun(renderer);
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    now = 11000;
    await handleRunStatus(renderer, 'root-stream', RUN_PHASE.COMPLETED);
    await handleRunDescription(
      renderer,
      'root-stream',
      'Running Mathematician team',
    );
    await handleTurn(renderer, 'root-stream', 3);
    await handleConversationProgress(renderer, 'root-stream', {
      toolCallCount: 9,
    });
    await handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        childRunId: 'late-child-stream' as RunId,
        agentName: 'late-review',
      }),
    ]);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · agent: review · 0s\n' +
        'orchestrator · Completed · 11s\n',
    );
  });

  it('does not repaint a child after the root stream is terminal', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleRunDescription(renderer, 'child-stream', 'Late review task');
    await handleActiveSubagents(renderer, 'root-stream', [subagentChild()]);
    await handleRunStatus(renderer, 'root-stream', RUN_PHASE.CANCELLED);
    await handleRunStatus(renderer, 'child-stream', RUN_PHASE.CANCELLED);

    expect(output.text).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · agent: review — Late review task · 0s\n' +
        'orchestrator · Stopped · 0s\n',
    );
  });

  it('freezes on a failed terminal stream stop, same as completed/cancelled', async () => {
    const output = outputBuffer();
    const renderer = plainRenderer(output, { minIntervalMs: 0 });

    await handleOrchestratorRootRun(renderer);
    await handleRunStatus(renderer, 'root-stream', RUN_PHASE.FAILED);
    // Post-terminal activity must not un-freeze the renderer (RUN_PHASE.FAILED
    // must be recognized as a terminal outcome phase, same as COMPLETED/CANCELLED).
    await handleConversationProgress(renderer, 'root-stream', {
      toolCallCount: 9,
    });
    await handleActiveSubagents(renderer, 'root-stream', [
      subagentChild({
        childRunId: 'late-child-stream' as RunId,
        agentName: 'late-review',
      }),
    ]);

    expect(output.text).toBe('orchestrator · 0s\norchestrator · Error · 0s\n');
  });

  it('derives the run progress flag from quiet and structured-output contexts', async () => {
    expect(shouldRenderRunProgress(context())).toBe(true);
    expect(shouldRenderRunProgress(context({ quietLogs: true }))).toBe(false);
    expect(shouldRenderRunProgress(context({ mode: 'headless' }))).toBe(true);
    expect(shouldRenderRunProgress(context({ outputFormat: 'json' }))).toBe(
      true,
    );
    expect(shouldRenderRunProgress(context({ outputFormat: 'ndjson' }))).toBe(
      false,
    );
    expect(shouldRenderRunProgress(context({ stderrIsTty: false }))).toBe(true);
  });

  it.live('uses the stderr color gate when stdout alone allows color', () =>
    Effect.gen(function* () {
      const output = yield* captureStreamWrites(
        process.stderr,
        Effect.gen(function* () {
          const session = yield* createTestSession();
          const host = createCliRuntimeHost(
            context({
              quietLogs: true,
              renderRunProgress: true,
              stdoutColorEnabled: true,
              stderrColorEnabled: false,
            }),
          );
          const scope = yield* Scope.make();
          yield* host
            .attachRunProgressRenderer(session)
            .pipe(Scope.provide(scope));
          // The session's graph is fresh: let its fold subscribe before the
          // facts land, so each fact paints as its own level.
          yield* Effect.promise(() => settle());
          yield* publishRun(session, { runId: 'a1a1a1' });
          yield* Scope.close(scope, Exit.void);
          yield* host.close();
        }),
      );

      expect(output).toContain('polish paper.tex · 0s');
      expect(output).not.toContain('\r\x1b[2K');
    }),
  );

  it.live('writes one status line for a committed completion', () =>
    Effect.gen(function* () {
      const output = yield* captureStreamWrites(
        process.stderr,
        Effect.gen(function* () {
          const session = yield* createTestSession();
          const host = createCliRuntimeHost(
            context({
              stderrColorEnabled: false,
              quietLogs: true,
              renderRunProgress: true,
            }),
          );
          const scope = yield* Scope.make();
          yield* host
            .attachRunProgressRenderer(session)
            .pipe(Scope.provide(scope));
          yield* publishRun(session, { runId: 'b2b2b2' });
          yield* session.log.settled;
          // The terminal phase is the `run.end` row's fact and nothing else, so
          // exactly one line renders for the transition.
          publishTestRows(session, [
            {
              type: 'run.end',
              aggregateId: qualifyAggregateId('run', 'b2b2b2' as RunId),
              outcome: 'completed',
              output: { response: '', files: [] },
            },
          ]);
          yield* session.log.settled;

          yield* Scope.close(scope, Exit.void);
          yield* host.close();
        }),
      );

      expect(
        output.split('\n').filter((line) => line.includes('Completed')),
      ).toEqual(['[t1] · polish paper.tex · Completed · 0s']);
    }),
  );

  it.live('preserves the live progress line before interactive prompts', () =>
    Effect.gen(function* () {
      const output = yield* captureStreamWrites(
        process.stderr,
        Effect.gen(function* () {
          const session = yield* createTestSession();
          const host = createCliRuntimeHost(
            context({
              approvalPolicy: 'ask',
              approvalPrompt: () => Effect.succeed('n no review needed'),
            }),
          );

          const scope = yield* Scope.make();
          yield* host
            .attachRunProgressRenderer(session)
            .pipe(Scope.provide(scope));
          yield* publishRun(session, { runId: 'c3c3c3' });
          host.prepareInteractivePrompt?.();
          yield* Effect.promise(() => Promise.resolve());
          yield* Scope.close(scope, Exit.void);
          yield* host.close();
        }),
      );

      expect(output).toContain('\r\x1b[2K[t1] · polish paper.tex · 0s\n');
    }),
  );

  it.live('writes human progress to stderr without polluting json stdout', () =>
    Effect.gen(function* () {
      let stderr = '';
      const stdout = yield* captureStreamWrites(
        process.stdout,
        Effect.gen(function* () {
          stderr = yield* captureStreamWrites(
            process.stderr,
            Effect.gen(function* () {
              const session = yield* createTestSession();
              const host = createCliRuntimeHost(
                context({
                  outputFormat: 'json',
                  stderrColorEnabled: false,
                  renderRunProgress: true,
                }),
              );
              const scope = yield* Scope.make();
              yield* host
                .attachRunProgressRenderer(session)
                .pipe(Scope.provide(scope));
              yield* publishRun(session, { runId: 'd4d4d4' });
              yield* Scope.close(scope, Exit.void);
              yield* host.close();
            }),
          );
        }),
      );

      expect(stderr).toContain('polish paper.tex · 0s');
      expect(stdout).toBe('');
    }),
  );

  it.live(
    'prints requestShowInstruction text and a human-readable action hint to stderr in text mode',
    () =>
      Effect.gen(function* () {
        const output = yield* captureStreamWrites(
          process.stderr,
          Effect.gen(function* () {
            const host = createCliRuntimeHost(
              context({ outputFormat: 'text' }),
            );

            host.emit('requestShowInstruction', {
              key: 'missingApiKey',
              message:
                'API key not found. Set your API key in Settings and run again.',
              actions: ['set-api-key', 'open-configuration-guide'],
              showSuppress: false,
            });

            yield* host.close();
          }),
        );

        // The raw InstructionAction tokens are translated to human phrasing
        // (mirroring the extension's INSTRUCTION_ACTION_VIEW), not printed
        // verbatim.
        expect(output).toContain(
          'API key not found. Set your API key in Settings and run again. (set your API key (texra setup), see the configuration guide)',
        );
        expect(output).not.toContain('set-api-key');
        expect(output).not.toContain('open-configuration-guide');
      }),
  );

  it.live(
    'prints a visible agent-not-found error for showAgentConfigBanner in text mode',
    () =>
      Effect.gen(function* () {
        const output = yield* captureStreamWrites(
          process.stderr,
          Effect.gen(function* () {
            const host = createCliRuntimeHost(
              context({ outputFormat: 'text' }),
            );

            expect(
              host.emit('showAgentConfigBanner', {
                agentName: 'ghost',
              }),
            ).toBe(true);

            yield* host.close();
          }),
        );

        expect(output).toContain('Agent not found: ghost');
        expect(output).toContain('texra agents list');
      }),
  );

  it.live(
    'does not gate requestShowInstruction behind quietLogs in text mode',
    () =>
      Effect.gen(function* () {
        const output = yield* captureStreamWrites(
          process.stderr,
          Effect.gen(function* () {
            const host = createCliRuntimeHost(
              context({ outputFormat: 'text', quietLogs: true }),
            );

            host.emit('requestShowInstruction', {
              key: 'missingApiKey',
              message:
                'API key not found. Set your API key in Settings and run again.',
            });

            yield* host.close();
          }),
        );

        expect(output).toContain('API key not found.');
      }),
  );

  it.live(
    'writes projected subagent progress records to stdout in ndjson mode',
    () =>
      Effect.gen(function* () {
        const parentRunId = 'a1a1a1' as RunId;
        const childRunId = 'b1b1b1' as RunId;
        const output = yield* captureStreamWrites(
          process.stdout,
          Effect.gen(function* () {
            const session = yield* createTestSession();
            publishTestRunStart(session, parentRunId);
            yield* Effect.promise(() => settle());
            // The child list is the fold's: the parent's `childIds` and the child's own
            // row, derived beside the line that folded them.
            const detach = yield* attachCliSessionProgressProjection(session);
            publishTestRows(session, [
              {
                type: 'run.start',
                aggregateId: qualifyAggregateId('run', childRunId),
                identity: { kind: 'agent', agent: 'review' },
                userFollowUpSupport: 'unsupported',
                parent: { id: parentRunId, callId: null },
                provenance: null,
              },
            ]);
            yield* Effect.promise(() => settle());
            yield* detach;
          }),
        );

        const records = ndjsonRecords(output).filter(
          (record) => record.event === 'run.children',
        );

        expect(records).toEqual([
          expect.objectContaining({
            kind: 'progress',
            event: 'run.children',
            // The row carries the child's run id and identity under their own
            // names; `ready` is the fold's phase before the activation lands.
            payload: {
              runId: parentRunId,
              children: [
                {
                  childRunId,
                  agentName: 'review',
                  identity: { kind: 'agent', agent: 'review' },
                  status: 'ready',
                },
              ],
            },
            contract: 2,
          }),
        ]);
      }),
  );

  it.live(
    'applies an explicit ndjson policy to every runtime presentation request',
    () =>
      Effect.gen(function* () {
        const output = yield* captureStreamWrites(
          process.stdout,
          Effect.gen(function* () {
            const host = createCliRuntimeHost(
              context({ mode: 'headless', outputFormat: 'ndjson' }),
            );

            for (const [event, testCase] of Object.entries(
              RUNTIME_PRESENTATION_NDJSON_CASES,
            ) as [
              RuntimePresentationEvent,
              RuntimePresentationNdjsonCases[RuntimePresentationEvent],
            ][]) {
              host.emit(event, testCase.payload);
            }

            yield* host.close();
          }),
        );

        const records = ndjsonRecords(output);

        const expectedRecords = Object.values(
          RUNTIME_PRESENTATION_NDJSON_CASES,
        ).flatMap(({ policy }) =>
          policy.kind === 'log'
            ? [expect.objectContaining({ ...policy, ts: expect.any(String) })]
            : [],
        );
        expect(records).toEqual(expectedRecords);
      }),
  );
});

import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireResumedRunLease: vi.fn(),
  buildVars: vi.fn(),
  createTrace: vi.fn(),
  load: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  isRemoteAgent: () => false,
  resolveAgentForLaunch: mocks.resolve,
}));
vi.mock('@agent/runtime/agentLoad', () => ({
  loadAgentSettingAndPrompts: mocks.load,
}));
vi.mock('@transcript', async (importActual) => ({
  ...(await importActual<typeof import('@transcript')>()),
  createRunTrace: mocks.createTrace,
}));
vi.mock('@agent/prompt/userVars', () => ({ buildUserVars: mocks.buildVars }));
vi.mock('@agent/storage/runLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLease')>()),
  acquireResumedRunLease: mocks.acquireResumedRunLease,
  assertOwnedRunLease: vi.fn(),
}));
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

import { TraceEmitter } from '@agent/trace';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { registerRun } from '@agent/storage/runLifecycle';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  type AggregateId,
  AgentCategory,
  type SessionEvent,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  fakeProcessServices,
  type FakeProcessServices,
} from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { eventsOfType, recordSessionEvents } from '../progressTestUtils';

const LAUNCH_FAILURE = new Error('stop after run activation');

/** The run an aggregate key names: every fact here lives on a run. */
function runOf(key: AggregateId): RunId {
  const target = aggregateTarget(key);
  if (target.kind !== 'run') throw new Error('expected a run aggregate');
  return target.id;
}

const FRESH_RUN_ID = 'f1e501' as RunId;
const MODEL_COMPATIBILITY_KEY = 'OpenAIResponse' as const;

const config = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'gpt55',
  agentCategory: AgentCategory.ToolUse,
});

interface StartedLaunch {
  readonly session: ReturnType<typeof createTestSession>;
  /** The creation fact; absent on a resume, which activates an existing
   *  run and mints no `run.start` (decision 9). */
  readonly start: Extract<SessionEvent, { type: 'run.start' }> | undefined;
  readonly activate: Extract<SessionEvent, { type: 'run.activate' }>;
  readonly end: Extract<SessionEvent, { type: 'run.end' }>;
}

/**
 * Drive a launch that fails after its `run.start` (the reservation commit
 * point): the durable boundary the fold reads. The real trace is attached to
 * the session so the launch's facts reach the hub the way a run's do.
 */
async function captureStartedLaunch(
  run: (
    session: ReturnType<typeof createTestSession>,
  ) => Effect.Effect<unknown, Error, FakeProcessServices>,
  options: {
    /** The launching run, when this launch is a child. */
    readonly parentRunId?: RunId;
    /** A resume activates this already-created run instead of minting one. */
    readonly resumedRunId?: RunId;
  } = {},
): Promise<StartedLaunch> {
  const session = createTestSession();
  if (options.parentRunId) {
    publishTestRunStart(session, options.parentRunId);
    await session.settlePublications();
  }
  if (options.resumedRunId) {
    publishTestRunStart(session, options.resumedRunId, {
      parent: options.parentRunId ?? null,
    });
    await session.settlePublications();
  }
  const recordedSession = recordSessionEvents(session);
  const trace = new TraceEmitter();

  mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
  mocks.load.mockResolvedValueOnce([
    { agentCategory: AgentCategory.ToolUse },
    {},
  ]);
  mocks.createTrace.mockReturnValueOnce({
    trace,
    dispose: vi.fn(),
  });
  mocks.buildVars.mockRejectedValueOnce(LAUNCH_FAILURE);

  try {
    if (!options.resumedRunId)
      await Effect.runPromise(
        registerRun(session, FRESH_RUN_ID, config, 'chat', {
          identity: { kind: 'agent', agent: 'chat' },
          parentRunId: options.parentRunId,
        }),
      );
    await expect(
      Effect.runPromise(Effect.provide(run(session), fakeProcessServices())),
    ).rejects.toBe(LAUNCH_FAILURE);
    const starts = eventsOfType(await recordedSession.read(), 'run.start');
    expect(starts).toHaveLength(options.resumedRunId ? 0 : 1);
    const activations = eventsOfType(
      await recordedSession.read(),
      'run.activate',
    );
    expect(activations).toHaveLength(1);
    const ends = eventsOfType(await recordedSession.read(), 'run.end');
    expect(ends).toHaveLength(1);
    return {
      session,
      start: starts[0],
      activate: activations[0],
      end: ends[0],
    };
  } finally {
    session.dispose();
  }
}

/**
 * A launch that fails after `run.start` folds to failed, never to a ghost:
 * the existence fact carries the launch facts and the session's owner
 * token, and the same failure path ends the run with its terminal
 * `run.end` row and the FAILED phase.
 */
function expectStartedThenFailed(
  launch: StartedLaunch,
  parentRunId: RunId | undefined,
): void {
  const { start } = launch;
  if (!start) throw new Error('a fresh launch emits run.start');
  expect(start).toMatchObject({
    identity: { kind: 'agent', agent: 'chat' },
    category: AgentCategory.ToolUse,
    isRemote: false,
    // The parent edge is the whole of "is a child": the birth fact carries
    // it, and nothing else spells it.
    parent:
      parentRunId === undefined
        ? null
        : expect.objectContaining({ id: parentRunId }),
    approvalPolicy: launch.session.approvalPolicySnapshotFor(
      runOf(start.aggregateId),
    ),
  });
  expectActivatedThenFailed(launch);
  expect(launch.end.aggregateId).toBe(start.aggregateId);
}

/** Every activation, fresh or resumed, carries the activation metadata the
 *  frozen wire projects and ends on the same failure path. */
function expectActivatedThenFailed(launch: StartedLaunch): void {
  expect(launch.activate).toMatchObject({
    category: AgentCategory.ToolUse,
    isRemote: false,
  });
  expect(launch.end).toMatchObject({
    outcome: RUN_OUTCOME.FAILED,
    aggregateId: launch.activate.aggregateId,
  });
  expect(
    launch.session.runView(runOf(launch.activate.aggregateId))?.status,
  ).toBe(RUN_PHASE.FAILED);
}

describe('native agent launch activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireResumedRunLease.mockResolvedValue('existing');
  });

  it.each([
    { label: 'child', parentRunId: 'e11000' as RunId },
    { label: 'root', parentRunId: undefined },
  ])(
    'starts a fresh $label launch at the commit point and fails it on the same path',
    async ({ parentRunId }) => {
      // The parent edge picks an `executeAgent` overload, so the call site
      // has to name it rather than let `it.each` widen it.
      const launch = await captureStartedLaunch(
        (session) =>
          prepareAgentDefinition({ config, session }).pipe(
            Effect.flatMap((definition) =>
              parentRunId
                ? executeAgent(definition, FRESH_RUN_ID, {
                    session,
                    parentRunId,
                    modelCompatibilityKey: MODEL_COMPATIBILITY_KEY,
                  })
                : executeAgent(definition, FRESH_RUN_ID, {
                    session,
                    modelCompatibilityKey: MODEL_COMPATIBILITY_KEY,
                  }),
            ),
          ),
        { parentRunId },
      );

      expectStartedThenFailed(launch, parentRunId);
      expect(launch.activate.aggregateId).toBe(launch.start?.aggregateId);
    },
  );

  it.each([
    { label: 'child', parentRunId: 'e11001' as RunId },
    { label: 'root', parentRunId: undefined },
  ])(
    'starts a resumed $label launch at the commit point and fails it on the same path',
    async ({ parentRunId }) => {
      const runId = 'ae5010' as RunId;
      const resume = createToolUseResumeData({
        runId,
        agentConfig: config,
        modelCompatibilityKey: MODEL_COMPATIBILITY_KEY,
      });
      mocks.retrieveSessionResumeData.mockReturnValueOnce(
        Effect.succeed(resume),
      );

      const launch = await captureStartedLaunch(
        (session) => resumeToolUseFromResumeData(resume, { session }),
        { parentRunId, resumedRunId: runId },
      );

      // A resume activates the run it already has: no second creation
      // fact, one activation on the same failure path.
      expectActivatedThenFailed(launch);
      expect(launch.start).toBeUndefined();
      expect(launch.activate.aggregateId).toBe(
        qualifyAggregateId('run', runId),
      );
    },
  );
});

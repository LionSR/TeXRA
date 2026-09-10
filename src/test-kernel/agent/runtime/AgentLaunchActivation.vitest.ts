import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireResumedRunLease: vi.fn(),
  buildVars: vi.fn(),
  createHandler: vi.fn(),
  createTrace: vi.fn(),
  getPersistedUserFollowUpSupport: vi.fn(),
  hasPersistedParent: vi.fn(),
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
vi.mock('@agent/runtime/ModelFactory', () => ({
  createModelHandler: mocks.createHandler,
  createModelHandlerForCompatibilityKey: mocks.createHandler,
}));
vi.mock('@transcript', async (importActual) => ({
  ...(await importActual<typeof import('@transcript')>()),
  createRunTrace: mocks.createTrace,
}));
vi.mock('@agent/prompt/userVars', () => ({ buildUserVars: mocks.buildVars }));
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent/storage/runLifecycle')
  >()),
  getPersistedUserFollowUpSupport: mocks.getPersistedUserFollowUpSupport,
  hasPersistedParent: mocks.hasPersistedParent,
}));
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
import { getStreamTabId } from '@agent/runtime/runTab';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunId,
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  AgentCategory,
  type SessionEvent,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { eventsOfType, recordSessionEvents } from '../progressTestUtils';

const LAUNCH_FAILURE = new Error('stop after stream activation');
const MODEL_HANDLER_KEY = 'ModelHandlerOpenAIResponse' as const;

const config = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'gpt55',
  agentCategory: AgentCategory.ToolUse,
});

interface StartedLaunch {
  readonly session: ReturnType<typeof createTestSession>;
  /** The creation fact; absent on a resume, which activates an existing
   *  stream and mints no `run.start` (decision 9). */
  readonly start: Extract<SessionEvent, { type: 'run.start' }> | undefined;
  readonly activate: Extract<SessionEvent, { type: 'run.activate' }>;
  readonly result: Extract<SessionEvent, { type: 'result' }>;
}

/**
 * Drive a launch that fails after its `run.start` (the reservation commit
 * point): the durable boundary the fold reads. The real trace is attached to
 * the session so the launch's facts reach the hub the way a run's do.
 */
async function captureStartedLaunch(
  run: (
    session: ReturnType<typeof createTestSession>,
  ) => Effect.Effect<unknown, Error>,
  options: {
    readonly isSubagent?: boolean;
    readonly resumed?: { runId: RunId; runId: RunId };
  } = {},
): Promise<StartedLaunch> {
  const session = createTestSession();
  if (options.resumed) {
    publishTestRunStart(
      session,
      options.resumed.runId,
      options.resumed.runId,
    );
    await session.settlePublications();
  }
  const recordedSession = recordSessionEvents(session);
  const trace = new TraceEmitter();
  const handler = {
    capabilities: { supportsVision: false, supportsNativeAudio: false },
    config: { provider: 'openai' },
    setAgentCategory: vi.fn(),
    setLogger: vi.fn(),
    dispose: vi.fn(),
  };

  mocks.resolve.mockReturnValueOnce({
    entry: { path: '/agents/chat.yaml' },
  });
  mocks.load.mockResolvedValueOnce([
    { agentCategory: AgentCategory.ToolUse },
    {},
  ]);
  mocks.createHandler.mockResolvedValueOnce(handler);
  mocks.createTrace.mockReturnValueOnce({
    trace,
    dispose: vi.fn(),
  });
  mocks.buildVars.mockRejectedValueOnce(LAUNCH_FAILURE);

  try {
    if (!options.resumed)
      await Effect.runPromise(
        registerRun(session, 'f1e501', config, 'chat', {
          runId: getStreamTabId(config.agent, { runId: 'f1e501' }),
          identity: { kind: 'agent', agent: 'chat' },
          background: options.isSubagent ?? false,
        }),
      );
    await expect(Effect.runPromise(run(session))).rejects.toBe(LAUNCH_FAILURE);
    const starts = eventsOfType(await recordedSession.read(), 'run.start');
    expect(starts).toHaveLength(options.resumed ? 0 : 1);
    const activations = eventsOfType(
      await recordedSession.read(),
      'run.activate',
    );
    expect(activations).toHaveLength(1);
    const results = eventsOfType(await recordedSession.read(), 'result');
    expect(results).toHaveLength(1);
    return {
      session,
      start: starts[0],
      activate: activations[0],
      result: results[0],
    };
  } finally {
    session.dispose();
  }
}

/**
 * A launch that fails after `run.start` folds to failed, never to a ghost:
 * the existence fact carries the launch facts and the session's owner
 * token, and the same failure path ends the stream with its terminal
 * `result` and the FAILED phase.
 */
function expectStartedThenFailed(
  launch: StartedLaunch,
  isSubagent: boolean,
): void {
  const { start } = launch;
  if (!start) throw new Error('a fresh launch emits run.start');
  expect(start).toMatchObject({
    identity: { kind: 'agent', agent: 'chat' },
    category: AgentCategory.ToolUse,
    isRemote: false,
    background: isSubagent,
    approvalPolicy: launch.session.approvalPolicySnapshotFor(
      aggregateTarget(start.aggregateId).id,
    ),
  });
  expectActivatedThenFailed(launch, isSubagent);
  expect(launch.result).toMatchObject({ runId: start.runId });
}

/** Every activation, fresh or resumed, carries the activation metadata the
 *  frozen wire projects and ends on the same failure path. */
function expectActivatedThenFailed(
  launch: StartedLaunch,
  isSubagent: boolean,
): void {
  expect(launch.activate).toMatchObject({
    category: AgentCategory.ToolUse,
    isRemote: false,
    background: isSubagent,
  });
  expect(launch.result).toMatchObject({
    outcome: RUN_OUTCOME.FAILED,
    aggregateId: launch.activate.aggregateId,
    isSubagent,
  });
  expect(
    launch.session.status.get(aggregateTarget(launch.activate.aggregateId).id),
  ).toBe(RUN_PHASE.FAILED);
}

describe('native agent launch activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireResumedRunLease.mockResolvedValue('existing');
    mocks.getPersistedUserFollowUpSupport.mockReturnValue(
      Effect.succeed(USER_FOLLOW_UP_SUPPORT.UNSUPPORTED),
    );
  });

  it.each([
    { label: 'child', isSubagent: true },
    { label: 'root', isSubagent: undefined },
  ])(
    'starts a fresh $label launch at the commit point and fails it on the same path',
    async ({ isSubagent }) => {
      // The subagent flag picks an `executeAgent` overload, so the literal
      // has to be visible at the call site rather than widened by `it.each`.
      const launch = await captureStartedLaunch(
        (session) =>
          prepareAgentDefinition({ config, session }).pipe(
            Effect.flatMap((definition) =>
              isSubagent
                ? executeAgent(definition, 'f1e501' as RunId, {
                    session,
                    isSubagent: true,
                    modelHandlerCompatibilityKey: MODEL_HANDLER_KEY,
                  })
                : executeAgent(definition, 'f1e501' as RunId, {
                    session,
                    modelHandlerCompatibilityKey: MODEL_HANDLER_KEY,
                  }),
            ),
          ),
        { isSubagent },
      );

      expectStartedThenFailed(launch, isSubagent === true);
      expect(launch.start).not.toHaveProperty('parentRunId');
      expect(launch.activate.aggregateId).toBe(launch.start?.aggregateId);
    },
  );

  it.each([
    { label: 'child', isSubagent: true },
    { label: 'root', isSubagent: false },
  ])(
    'starts a resumed $label launch at the commit point and fails it on the same path',
    async ({ isSubagent }) => {
      const runId = 'ae5010' as RunId;
      const runId = 'resumed-stream' as RunId;
      mocks.hasPersistedParent.mockReturnValueOnce(Effect.succeed(isSubagent));
      const resume = createToolUseResumeData({
        runId,
        runId,
        agentConfig: config,
        shared: { modelHandlerCompatibilityKey: MODEL_HANDLER_KEY },
      });
      mocks.retrieveSessionResumeData.mockReturnValueOnce(
        Effect.succeed(resume),
      );

      const launch = await captureStartedLaunch(
        (session) => resumeToolUseFromResumeData(resume, { session }),
        { resumed: { runId, runId } },
      );

      // A resume activates the stream it already has: no second creation
      // fact, one activation on the same failure path.
      expectActivatedThenFailed(launch, isSubagent);
      expect(launch.start).toBeUndefined();
      expect(launch.activate.aggregateId).toBe(
        qualifyAggregateId('stream', runId),
      );
    },
  );
});

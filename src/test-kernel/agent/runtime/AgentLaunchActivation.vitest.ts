import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireResumedExecutionLease: vi.fn(),
  buildVars: vi.fn(),
  clearTerminalExecutionState: vi.fn(),
  createHandler: vi.fn(),
  createTrace: vi.fn(),
  getPersistedUserFollowUpSupport: vi.fn(),
  hasPersistedParent: vi.fn(),
  load: vi.fn(),
  releaseOwnedExecutionLeaseAfterFailure: vi.fn(),
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
vi.mock('@agent/storage/executionLifecycle', () => ({
  clearTerminalExecutionState: mocks.clearTerminalExecutionState,
  getPersistedUserFollowUpSupport: mocks.getPersistedUserFollowUpSupport,
  hasPersistedParent: mocks.hasPersistedParent,
}));
vi.mock('@agent/storage/executionLease', () => ({
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  assertOwnedExecutionLease: vi.fn(),
  releaseOwnedExecutionLeaseAfterFailure:
    mocks.releaseOwnedExecutionLeaseAfterFailure,
}));
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

import { TraceEmitter } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { recordSessionEvents, runEventsOfType } from '../progressTestUtils';

const LAUNCH_FAILURE = new Error('stop after stream activation');
const MODEL_HANDLER_KEY = 'ModelHandlerOpenAIResponse' as const;

const config = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'gpt55',
  agentCategory: AgentCategory.ToolUse,
});

interface StartedLaunch {
  readonly session: ReturnType<typeof createTestSession>;
  readonly start: ReturnType<typeof runEventsOfType<'run.start'>>[number];
  readonly result: ReturnType<typeof runEventsOfType<'result'>>[number];
}

/**
 * Drive a launch that fails after its `run.start` (the reservation commit
 * point): the durable boundary the fold reads. The real trace is attached to
 * the session so the launch's facts reach the hub the way a run's do.
 */
async function captureStartedLaunch(
  run: (session: ReturnType<typeof createTestSession>) => Promise<unknown>,
): Promise<StartedLaunch> {
  const session = createTestSession();
  const recordedSession = recordSessionEvents(session.events);
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
    handleStatus: vi.fn(),
    flushSpills: vi.fn(async () => undefined),
    dispose: vi.fn(),
  });
  mocks.buildVars.mockRejectedValueOnce(LAUNCH_FAILURE);

  try {
    await expect(run(session)).rejects.toBe(LAUNCH_FAILURE);
    const starts = runEventsOfType(recordedSession.events, 'run.start');
    expect(starts).toHaveLength(1);
    const results = runEventsOfType(recordedSession.events, 'result');
    expect(results).toHaveLength(1);
    return { session, start: starts[0], result: results[0] };
  } finally {
    recordedSession.detach();
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
  expect(launch.start).toMatchObject({
    identity: { kind: 'agent', agent: 'chat' },
    agentCategory: AgentCategory.ToolUse,
    isRemote: false,
    ownerId: launch.session.ownerId,
  });
  expect(launch.result).toMatchObject({
    outcome: RUN_OUTCOME.FAILED,
    streamId: launch.start.streamId,
    executionId: launch.start.executionId,
    isSubagent,
  });
  expect(launch.session.status.get(launch.start.streamId)).toBe(
    STREAM_PHASE.FAILED,
  );
}

describe('native agent launch activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireResumedExecutionLease.mockResolvedValue('existing');
    mocks.clearTerminalExecutionState.mockResolvedValue(undefined);
    mocks.getPersistedUserFollowUpSupport.mockResolvedValue(
      USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    );
    mocks.releaseOwnedExecutionLeaseAfterFailure.mockImplementation(
      async (_executionId: ExecutionId, error: unknown) => error,
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
      const launch = await captureStartedLaunch((session) =>
        isSubagent
          ? executeAgent(config, 'fresh-launch' as ExecutionId, {
              session,
              isSubagent: true,
              modelHandlerCompatibilityKey: MODEL_HANDLER_KEY,
            })
          : executeAgent(config, 'fresh-launch' as ExecutionId, {
              session,
              modelHandlerCompatibilityKey: MODEL_HANDLER_KEY,
            }),
      );

      expectStartedThenFailed(launch, isSubagent === true);
      expect(launch.start).not.toHaveProperty('parentStreamId');
    },
  );

  it.each([
    { label: 'child', isSubagent: true },
    { label: 'root', isSubagent: false },
  ])(
    'starts a resumed $label launch at the commit point and fails it on the same path',
    async ({ isSubagent }) => {
      const executionId = 'resumed-launch' as ExecutionId;
      const streamId = 'resumed-stream' as StreamTabId;
      mocks.hasPersistedParent.mockResolvedValueOnce(isSubagent);
      const resume = createToolUseResumeData({
        executionId,
        streamId,
        agentConfig: config,
        shared: { modelHandlerCompatibilityKey: MODEL_HANDLER_KEY },
      });
      mocks.retrieveSessionResumeData.mockResolvedValueOnce(resume);

      const launch = await captureStartedLaunch((session) =>
        resumeToolUseFromResumeData(resume, { session }),
      );

      expectStartedThenFailed(launch, isSubagent);
      expect(launch.start.streamId).toBe(streamId);
      expect(launch.start.userFollowUpSupport).toBe(
        USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      );
    },
  );
});

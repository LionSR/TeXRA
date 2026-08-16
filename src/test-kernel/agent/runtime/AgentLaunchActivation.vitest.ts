import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireResumedExecutionLease: vi.fn(),
  buildVars: vi.fn(),
  clearTerminalExecutionState: vi.fn(),
  completeOwnedExecutionLease: vi.fn(),
  createHandler: vi.fn(),
  createTrace: vi.fn(),
  getPersistedUserFollowUpSupport: vi.fn(),
  hasPersistedParent: vi.fn(),
  load: vi.fn(),
  releaseOwnedExecutionLeaseAfterFailure: vi.fn(),
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
  abandonOwnedExecutionLease: vi.fn(),
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
  completeOwnedExecutionLease: mocks.completeOwnedExecutionLease,
  releaseOwnedExecutionLeaseAfterFailure:
    mocks.releaseOwnedExecutionLeaseAfterFailure,
}));

import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import {
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type SetActiveStreamPayload,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { recordSessionEvents, sessionFactPayloads } from '../progressTestUtils';

const LAUNCH_FAILURE = new Error('stop after stream activation');
const MODEL_HANDLER_KEY = 'ModelHandlerOpenAIResponse' as const;

const config = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'gpt55',
  agentCategory: AgentCategory.ToolUse,
});

async function captureActivation(
  run: (session: ReturnType<typeof createTestSession>) => Promise<unknown>,
): Promise<SetActiveStreamPayload> {
  const session = createTestSession();
  const recordedSession = recordSessionEvents(session.events);
  const trace = { ...noopTrace, subscribe: vi.fn(() => vi.fn()) };
  trace.openStage = vi.fn(() => noopTrace.openStage('Run'));
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
  mocks.createTrace.mockReturnValueOnce({ trace, dispose: vi.fn() });
  mocks.buildVars.mockRejectedValueOnce(LAUNCH_FAILURE);

  try {
    await expect(run(session)).rejects.toBe(LAUNCH_FAILURE);
    const payloads = sessionFactPayloads(
      recordedSession.events,
      'setActiveStream',
    );
    expect(payloads).toHaveLength(1);
    return payloads[0] as SetActiveStreamPayload;
  } finally {
    recordedSession.detach();
    session.dispose();
  }
}

function expectActivation(
  payload: SetActiveStreamPayload,
  suppressViewSwitch: boolean,
): void {
  expect(payload).toMatchObject({
    agentCategory: AgentCategory.ToolUse,
    isRemote: false,
  });
  if (suppressViewSwitch) {
    expect(payload).toHaveProperty('suppressViewSwitch', true);
  } else {
    expect(payload).not.toHaveProperty('suppressViewSwitch');
  }
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
    mocks.completeOwnedExecutionLease.mockResolvedValue({ status: 'released' });
  });

  it.each([
    { label: 'child', isSubagent: true, suppressViewSwitch: true },
    { label: 'root', isSubagent: undefined, suppressViewSwitch: false },
  ])(
    'emits the expected activation payload for a fresh $label launch',
    async ({ isSubagent, suppressViewSwitch }) => {
      const payload = await captureActivation((session) =>
        executeAgent(config, 'fresh-launch' as ExecutionId, {
          session,
          isSubagent,
          modelHandlerCompatibilityKey: MODEL_HANDLER_KEY,
        }),
      );

      expectActivation(payload, suppressViewSwitch);
    },
  );

  it.each([
    { label: 'child', isSubagent: true, suppressViewSwitch: true },
    { label: 'root', isSubagent: false, suppressViewSwitch: false },
  ])(
    'emits the expected activation payload for a resumed $label launch',
    async ({ isSubagent, suppressViewSwitch }) => {
      const executionId = 'resumed-launch' as ExecutionId;
      const streamId = 'resumed-stream' as StreamTabId;
      mocks.hasPersistedParent.mockResolvedValueOnce(isSubagent);
      const resume = createToolUseResumeData({
        executionId,
        streamId,
        agentConfig: config,
        shared: { modelHandlerCompatibilityKey: MODEL_HANDLER_KEY },
      });

      const payload = await captureActivation((session) =>
        resumeToolUseFromResumeData(resume, { session }),
      );

      expectActivation(payload, suppressViewSwitch);
      expect(payload.streamId).toBe(streamId);
    },
  );
});

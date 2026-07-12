// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { setupPlatform } from '@test/support/setupPlatform';

// Local imports - agent
import { getExecutionStore } from '@agent/storage';
import { noopTrace } from '@agent/trace';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import {
  PersistedFlowStateError,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  runReflectionFlow,
  type RunReflectionFlowInput,
} from '@agent/implementations/flows/reflection/runReflectionFlow';
import { ReflectionFlowStateCanonicalSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const CONFIG: AgentConfig = {
  inputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
  editedFile: null,
  agent: 'reflection-test',
  model: 'gpt54',
  instruction: 'Continue.',
  agentCategory: AgentCategory.Workflow,
  editedFiles: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
  memories: [],
  workingDirectory: '/workspace',
  cliOutputFile: null,
  cliMultiAgentPresetId: null,
};
const SETTING = AgentWorkflowSettingSchema.parse({ rounds: 1 });
const PROMPT = AgentPromptSchema.parse({ userRequest: 'Start the workflow.' });
const ACTIVE_COMPATIBILITY_KEY = 'ModelHandlerOpenAIResponse';

function createModelHandler(): RunReflectionFlowInput['modelHandler'] {
  const handler = {
    initializeMessages: async (_prefix: string, request: string) => [
      { role: 'user' as const, content: request },
    ],
  };
  Object.defineProperty(handler, '__texraModelHandlerCompatibilityKey', {
    value: ACTIVE_COMPATIBILITY_KEY,
  });
  return handler as unknown as RunReflectionFlowInput['modelHandler'];
}

async function runPersistedReflectionFlow(
  executionId: ExecutionId,
  streamId: StreamTabId,
): Promise<Awaited<ReturnType<typeof runReflectionFlow>>> {
  const session = new SessionHandle();
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => CONFIG.model,
    runScope: createRunScope({
      runtimeHost: noopAgentRuntimeHost,
      streamId,
      executionId,
      agentName: CONFIG.agent,
      session,
    }),
  });

  try {
    return await withRunContext(context, () =>
      runReflectionFlow({
        config: CONFIG,
        setting: SETTING,
        prompt: PROMPT,
        logger: noopTrace,
        storageKey: executionId as StorageKey,
        parentStage: noopTrace.openStage('Reflection flow recovery test'),
        userVarChannels: {
          input: Object.freeze({ MODEL: CONFIG.model }),
          transient: {},
        },
        modelHandler: createModelHandler(),
        streamStatus: session.status,
        checkInterruption: () => true,
        setAbortController: () => {},
      }),
    );
  } finally {
    session.dispose();
  }
}

function flowRecord(shared: unknown): FlowRecord {
  return {
    flowName: 'texra',
    shared,
    createdAt: '2026-01-01T00:00:00.000Z',
    cursor: { nextNodeId: null },
    nodes: [],
  };
}

describe('runReflectionFlow persisted-state recovery', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('creates fresh shared state when the flow record is absent', async () => {
    const executionId = 'reflection-flow-absent' as ExecutionId;
    const streamId = 'workflow@gpt54#reflection-flow-absent' as StreamTabId;

    const result = await runPersistedReflectionFlow(executionId, streamId);

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    const stored = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );
    expect(
      ReflectionFlowStateCanonicalSchema.parse(stored?.shared),
    ).toMatchObject({
      currentRound: 0,
      totalRounds: 1,
      conversation: [],
      modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
    });
  });

  it('propagates a persistence read failure without deleting the flow record', async () => {
    const executionId = 'reflection-flow-read-failure' as ExecutionId;
    const streamId =
      'workflow@gpt54#reflection-flow-read-failure' as StreamTabId;
    const store = getExecutionStore(executionId);
    const readFailure = new Error('flow storage unavailable');
    const readSpy = vi.spyOn(store, 'read').mockRejectedValueOnce(readFailure);
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      await expect(
        runPersistedReflectionFlow(executionId, streamId),
      ).rejects.toMatchObject({
        name: PersistedFlowStateError.name,
        reason: 'read-failed',
        cause: readFailure,
      });
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it.each([
    {
      name: 'invalid shared state',
      reason: 'invalid-shared',
      stored: flowRecord({ currentRound: 'zero' }),
    },
    {
      name: 'missing shared state',
      reason: 'missing-shared',
      stored: {
        flowName: 'texra',
        createdAt: '2026-01-01T00:00:00.000Z',
        nodes: [],
      },
    },
    {
      name: 'unsupported null record',
      reason: 'unsupported-record',
      stored: null,
    },
  ])('rejects and preserves $name', async ({ name, reason, stored }) => {
    const slug = name.replaceAll(' ', '-');
    const executionId = `reflection-flow-${slug}` as ExecutionId;
    const streamId = `workflow@gpt54#reflection-flow-${slug}` as StreamTabId;
    const store = getExecutionStore(executionId);
    await store.write(flowKey(executionId), stored);
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      await expect(
        runPersistedReflectionFlow(executionId, streamId),
      ).rejects.toMatchObject({
        name: PersistedFlowStateError.name,
        reason,
      });
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await store.read(flowKey(executionId))).toEqual(stored);
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('migrates a valid legacy workspace snapshot before canonical writes', async () => {
    const executionId = 'reflection-flow-legacy-workspace' as ExecutionId;
    const streamId =
      'workflow@gpt54#reflection-flow-legacy-workspace' as StreamTabId;
    const todo = {
      content: 'Preserve legacy workflow state',
      status: 'in_progress' as const,
      activeForm: 'Preserving legacy workflow state',
    };
    const legacyShared = {
      currentRound: 0,
      totalRounds: 2,
      workspaceSnapshot: { todos: { todos: [todo] } },
      context: null,
      outputLocation: null,
      conversation: [],
      runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
      roundStateSnapshots: [],
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
    };
    const store = getExecutionStore(executionId);
    await store.write(flowKey(executionId), flowRecord(legacyShared));

    const result = await runPersistedReflectionFlow(executionId, streamId);

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    const stored = await store.read<FlowRecord>(flowKey(executionId));
    const shared = ReflectionFlowStateCanonicalSchema.parse(stored?.shared);
    expect(shared.workspaceSnapshot.workPlan.todos).toEqual([todo]);
    expect(Object.hasOwn(shared.workspaceSnapshot, 'todos')).toBe(false);
  });
});

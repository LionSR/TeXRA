// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { getExecutionStore } from '@agent/storage';
import { noopTrace } from '@agent/trace';
import {
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  PersistedFlowStateError,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  runReflectionFlow,
  type RunReflectionFlowInput,
} from '@agent/implementations/flows/reflection/runReflectionFlow';
import { ReflectionFlowStateCanonicalSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { testModelCell } from './modelCellTestUtils';
import { reflectionFlowShared } from './progressTestUtils';

const CONFIG = AgentConfigSchema.parse({
  agent: 'reflection-test',
  model: 'gpt54',
  instruction: 'Continue.',
  agentCategory: AgentCategory.Workflow,
  workingDirectory: '/workspace',
});
const SETTING = AgentWorkflowSettingSchema.parse({ rounds: 1 });
const PROMPT = AgentPromptSchema.parse({ userRequest: 'Start the workflow.' });
const ACTIVE_COMPATIBILITY_KEY = 'ModelHandlerOpenAIResponse';

function createModelCell(): RunReflectionFlowInput['modelCell'] {
  const handler = {
    initializeMessages: async (_prefix: string, request: string) => [
      { role: 'user' as const, content: request },
    ],
  };
  Object.defineProperty(handler, '__texraModelHandlerCompatibilityKey', {
    value: ACTIVE_COMPATIBILITY_KEY,
  });
  return testModelCell(handler, CONFIG.model);
}

async function runPersistedReflectionFlow(
  executionId: ExecutionId,
  streamId: StreamTabId,
): Promise<Awaited<ReturnType<typeof runReflectionFlow>>> {
  const session = createTestSession();
  const runScope = createRunScope({
    streamId,
    executionId,
    agentName: CONFIG.agent,
    session,
    signal: AbortSignal.abort(),
  });
  const modelCell = createModelCell();
  const context = createRunContext({ runScope, modelCell });

  try {
    return await withRunContext(context, () =>
      runReflectionFlow({
        config: CONFIG,
        runScope,
        setting: SETTING,
        prompt: PROMPT,
        logger: noopTrace,
        storageKey: executionId as StorageKey,
        parentStage: noopTrace.openStage('Reflection flow recovery test'),
        userVarChannels: {
          input: Object.freeze({ MODEL: CONFIG.model }),
          transient: {},
        },
        modelCell,
        onRoundFinalized: () => {},
      }),
    );
  } finally {
    session.dispose();
  }
}

function recoveryCase(name: string) {
  const executionId = `reflection-flow-${name}` as ExecutionId;
  const streamId = `workflow@gpt54#reflection-flow-${name}` as StreamTabId;
  return {
    key: flowKey(executionId),
    run: () => runPersistedReflectionFlow(executionId, streamId),
    store: getExecutionStore(executionId),
  };
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
  afterEach(() => vi.restoreAllMocks());

  it('creates fresh shared state when the flow record is absent', async () => {
    const { key, run, store } = recoveryCase('absent');

    const result = await run();

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    const stored = await store.read<FlowRecord>(key);
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
    const { run, store } = recoveryCase('read-failure');
    const readFailure = new Error('flow storage unavailable');
    vi.spyOn(store, 'read').mockRejectedValueOnce(readFailure);
    const deleteSpy = vi.spyOn(store, 'delete');

    await expect(run()).rejects.toMatchObject({
      name: PersistedFlowStateError.name,
      reason: 'read-failed',
      cause: readFailure,
    });
    expect(deleteSpy).not.toHaveBeenCalled();
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
    {
      name: 'valid shared state without nodes',
      reason: 'unsupported-record',
      stored: {
        flowName: 'texra',
        shared: reflectionFlowShared({ totalRounds: 1, context: null }),
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    {
      name: 'future envelope schema version',
      reason: 'unsupported-record',
      stored: {
        ...flowRecord(reflectionFlowShared({ totalRounds: 1, context: null })),
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION + 1,
      },
    },
  ])('rejects and preserves $name', async ({ name, reason, stored }) => {
    const { key, run, store } = recoveryCase(name.replaceAll(' ', '-'));
    await store.write(key, stored);
    const deleteSpy = vi.spyOn(store, 'delete');

    await expect(run()).rejects.toMatchObject({
      name: PersistedFlowStateError.name,
      reason,
      cause: expect.objectContaining({ name: 'ZodError' }),
    });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await store.read(key)).toEqual(stored);
  });

  it('migrates a valid legacy workspace snapshot before canonical writes', async () => {
    const { key, run, store } = recoveryCase('legacy-workspace');
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
    await store.write(key, flowRecord(legacyShared));

    const result = await run();

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    const stored = await store.read<FlowRecord>(key);
    const shared = ReflectionFlowStateCanonicalSchema.parse(stored?.shared);
    expect(shared.workspaceSnapshot.workPlan.todos).toEqual([todo]);
    expect(Object.hasOwn(shared.workspaceSnapshot, 'todos')).toBe(false);
  });

  it('clears a persisted cancellation latch when resuming a workflow', async () => {
    const { key, run, store } = recoveryCase('cancelled-latch');
    const shared = reflectionFlowShared({
      totalRounds: 1,
      context: null,
      continueRounds: false,
      lastError: undefined,
    });
    await store.write(key, flowRecord(shared));

    const result = await run();

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    const stored = await store.read<FlowRecord>(key);
    expect(
      ReflectionFlowStateCanonicalSchema.parse(stored?.shared).continueRounds,
    ).toBe(true);
  });
});

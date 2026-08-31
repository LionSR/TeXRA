// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { getExecutionStore } from '@agent/storage';
import { noopTrace } from '@agent/trace';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
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
import { ReflectionFlowStateSchema } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { createTestSession } from '@test/support/sessionTestUtils';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
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
  logger: RunReflectionFlowInput['logger'] = noopTrace,
  options: { rounds?: number; aborted?: boolean } = {},
): Promise<Awaited<ReturnType<typeof runReflectionFlow>>> {
  const session = createTestSession();
  const runScope = createRunScope({
    streamId,
    executionId,
    agentName: CONFIG.agent,
    session,
    signal:
      options.aborted === false
        ? new AbortController().signal
        : AbortSignal.abort(),
  });
  const modelCell = createModelCell();
  const context = createRunContext({ runScope, modelCell });

  try {
    return await withRunContext(context, () =>
      runReflectionFlow({
        config: CONFIG,
        runScope,
        setting:
          options.rounds === undefined
            ? SETTING
            : AgentWorkflowSettingSchema.parse({ rounds: options.rounds }),
        prompt: PROMPT,
        logger,
        parentStage: logger.openStage('Reflection flow recovery test'),
        userVarChannels: { MODEL: CONFIG.model },
        modelCell,
        toolPolicy: createToolPolicy(),
        onRoundFinalized: () => {},
      }),
    );
  } finally {
    session.dispose();
  }
}

function recoveryCase(
  name: string,
  options: { rounds?: number; aborted?: boolean } = {},
) {
  const executionId = `reflection-flow-${name}` as ExecutionId;
  const streamId = `workflow@gpt54#reflection-flow-${name}` as StreamTabId;
  return {
    key: flowKey(executionId),
    run: () =>
      runPersistedReflectionFlow(executionId, streamId, noopTrace, options),
    store: getExecutionStore(executionId),
  };
}

function flowRecord(shared: unknown): FlowRecord {
  return {
    shared,
    cursor: { nextNodeId: null },
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
    expect(ReflectionFlowStateSchema.parse(stored?.shared)).toMatchObject({
      currentRound: 0,
      totalRounds: 1,
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

  it('reports workspace preparation failure even when validation prevents output extraction', async () => {
    const { key, store } = recoveryCase('preparation-failure');
    await store.write(key, flowRecord({ currentRound: 'zero' }));
    const preparationFailure = new Error('workspace unavailable');
    vi.spyOn(
      TaskRunFileService.prototype,
      'prepareRunWorkspace',
    ).mockRejectedValueOnce(preparationFailure);
    const logger = { ...noopTrace, warn: vi.fn() };

    await expect(
      runPersistedReflectionFlow(
        'reflection-flow-preparation-failure' as ExecutionId,
        'workflow@gpt54#reflection-flow-preparation-failure' as StreamTabId,
        logger,
      ),
    ).rejects.toMatchObject({
      name: PersistedFlowStateError.name,
      reason: 'invalid-shared',
    });

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('workspace unavailable'),
      { data: preparationFailure, messageType: MESSAGE_TYPES.INTERNAL },
    );
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
      stored: {},
    },
    {
      name: 'unsupported null record',
      reason: 'unsupported-record',
      stored: null,
    },
    {
      name: 'valid shared state without a replay cursor',
      reason: 'unsupported-record',
      stored: {
        shared: reflectionFlowShared({ totalRounds: 1, context: null }),
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

  it('rejects and preserves a retired workspace snapshot', async () => {
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
      runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
    };
    await store.write(key, flowRecord(legacyShared));

    await expect(run()).rejects.toMatchObject({
      name: PersistedFlowStateError.name,
      reason: 'invalid-shared',
      cause: expect.objectContaining({ name: 'ZodError' }),
    });
    expect(await store.read(key)).toEqual(flowRecord(legacyShared));
  });

  it('normalizes a legacy provider classification at the persisted state reader', () => {
    const legacyLastError = {
      message: 'legacy upstream credit record',
      userRetryable: true,
      isCredentialExhausted: true,
      isUpstreamCreditDepleted: true,
    };

    const shared = ReflectionFlowStateSchema.parse(
      reflectionFlowShared({ lastError: legacyLastError }),
    );

    expect(shared.lastError?.classification).toStrictEqual({
      kind: 'upstream-credit',
    });
    expect('isCredentialExhausted' in (shared.lastError ?? {})).toBe(false);
    expect(legacyLastError.isCredentialExhausted).toBe(true);
  });

  const syntheticCompileError = {
    message:
      'Automatic LaTeX compilation failed after the final workflow round.',
    userRetryable: false,
  };

  it('promotes context-only legacy rejection and fails at the same cap', async () => {
    const { key, run, store } = recoveryCase('legacy-context-same-cap', {
      aborted: false,
    });
    await store.write(
      key,
      flowRecord(
        reflectionFlowShared({
          totalRounds: 1,
          compileFailureContext: 'legacy compile failure',
        }),
      ),
    );

    const result = await run();
    expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
    expect(result.error).toBeUndefined();
    const shared = ReflectionFlowStateSchema.parse(
      (await store.read<FlowRecord>(key))?.shared,
    );
    expect(shared.unresolvedCompileRejection).toBe(true);
    expect(shared.lastError).toBeUndefined();
  });

  it('removes the legacy synthetic error but still fails at the same cap', async () => {
    const { key, run, store } = recoveryCase('legacy-error-same-cap', {
      aborted: false,
    });
    await store.write(
      key,
      flowRecord(
        reflectionFlowShared({
          totalRounds: 1,
          compileFailureContext: 'legacy compile failure',
          lastError: syntheticCompileError,
        }),
      ),
    );

    const result = await run();
    expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
    expect(result.error).toBeUndefined();
    const shared = ReflectionFlowStateSchema.parse(
      (await store.read<FlowRecord>(key))?.shared,
    );
    expect(shared.unresolvedCompileRejection).toBe(true);
    expect(shared.lastError).toBeUndefined();
  });

  it('preserves a genuine runtime error even with legacy rejection evidence', async () => {
    const { key, run, store } = recoveryCase('legacy-context-provider-error', {
      aborted: false,
    });
    const providerError = {
      message: 'Provider request failed',
      userRetryable: true,
      statusCode: 503,
    };
    await store.write(
      key,
      flowRecord(
        reflectionFlowShared({
          totalRounds: 1,
          compileFailureContext: 'legacy compile failure',
          lastError: providerError,
        }),
      ),
    );

    await expect(run()).resolves.toMatchObject({
      outcome: RUN_OUTCOME.FAILED,
      error: providerError,
    });
    const stored = await store.read<FlowRecord>(key);
    expect(ReflectionFlowStateSchema.parse(stored?.shared).lastError).toEqual(
      providerError,
    );
  });

  it.each([
    { name: 'context-only', lastError: undefined },
    { name: 'synthetic-error', lastError: syntheticCompileError },
  ])(
    'normalizes $name legacy rejection when the cap is raised',
    async ({ name, lastError }) => {
      const { key, run, store } = recoveryCase(`legacy-${name}-raised-cap`, {
        rounds: 2,
      });
      await store.write(
        key,
        flowRecord(
          reflectionFlowShared({
            totalRounds: 1,
            compileFailureContext: 'legacy compile failure',
            lastError,
          }),
        ),
      );

      const result = await run();
      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(result.error).toBeUndefined();
      const shared = ReflectionFlowStateSchema.parse(
        (await store.read<FlowRecord>(key))?.shared,
      );
      expect(shared.totalRounds).toBe(2);
      expect(shared.unresolvedCompileRejection).toBe(true);
      expect(shared.lastError).toBeUndefined();
    },
  );

  it.each([
    { name: 'context-only', lastError: undefined },
    { name: 'synthetic-error', lastError: syntheticCompileError },
  ])(
    'clears $name legacy rejection when rejection is disabled',
    async ({ name, lastError }) => {
      await installPlatform({
        workspacePath: '/workspace',
        workspaceState: {
          [WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE]: false,
        },
      });
      const { key, run, store } = recoveryCase(`legacy-${name}-disabled`, {
        aborted: false,
      });
      await store.write(
        key,
        flowRecord(
          reflectionFlowShared({
            totalRounds: 1,
            compileFailureContext: 'legacy compile failure',
            lastError,
          }),
        ),
      );

      const result = await run();
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(result.error).toBeUndefined();
      const shared = ReflectionFlowStateSchema.parse(
        (await store.read<FlowRecord>(key))?.shared,
      );
      expect(shared.compileFailureContext).toBeUndefined();
      expect(shared.unresolvedCompileRejection).toBeUndefined();
      expect(shared.lastError).toBeUndefined();
    },
  );

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
    expect(ReflectionFlowStateSchema.parse(stored?.shared).continueRounds).toBe(
      true,
    );
  });
});

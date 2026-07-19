// Test support imports

import { describe, expect, it, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  PersistedFlow,
  PersistedFlowStateError,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import {
  runToolUseFlow,
  type RunToolUseFlowResult,
  type RunToolUseFlowInput,
  type ToolUseFlowSetupCallback,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import {
  migrateSharedState,
  ToolUseRunSharedCanonicalSchema,
  type StateSlicesSnapshot,
} from '@agent/implementations/flows/tooluse/nodes/types';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

const CONFIG: AgentConfig = {
  inputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
  editedFile: null,
  agent: 'chat',
  model: 'gpt54',
  instruction: 'Continue.',
  agentCategory: AgentCategory.ToolUse,
  editedFiles: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
  memories: [],
  workingDirectory: '/workspace',
  cliOutputFile: null,
  cliMultiAgentPresetId: null,
};
const GOOGLE_CONFIG: AgentConfig = { ...CONFIG, model: 'gemini35f' };
const GOOGLE_WORKFLOW_CONFIG: AgentConfig = {
  ...GOOGLE_CONFIG,
  agentCategory: AgentCategory.Workflow,
};
const TOOL_USE_SETTING = AgentToolUseSettingSchema.parse({});
const TOOL_USE_PROMPT = AgentPromptSchema.parse({});
const ACTIVE_COMPATIBILITY_KEY = 'ModelHandlerOpenAIResponse';
const WAIT_NODE_CURSOR = 'start/default/default';
const VALID_TOOL_USE_SHARED = {
  messages: [],
  shouldSkipCycle: false,
  stateSlices: null,
};
type ToolUseSetupContext = Parameters<ToolUseFlowSetupCallback>[0];

// Most flow-record fixtures below persist a fresh run/workspace snapshot
// with only the current model and (occasionally) a transient override
// varying between cases.
function defaultStateSlices(
  model = 'gpt54',
  transient: Record<string, string> = {},
): StateSlicesSnapshot {
  return {
    runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
    workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
    userChannels: {
      input: Object.freeze({ MODEL: model }),
      transient,
    },
  };
}

function createTaggedModelHandler(
  compatibilityKey: ModelHandlerCompatibilityKey,
): RunToolUseFlowInput['modelHandler'] {
  const handler = { extractAssistantText: () => undefined };
  // ModelFactory installs this non-enumerable tag on every active handler.
  Object.defineProperty(handler, '__texraModelHandlerCompatibilityKey', {
    value: compatibilityKey,
  });
  return handler as unknown as RunToolUseFlowInput['modelHandler'];
}

function buildToolUseResumeData(
  executionId: ExecutionId,
  streamId: StreamTabId,
  sourceShared?: unknown,
): ToolUseResumeData {
  const shared = {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: defaultStateSlices(),
  };
  return {
    type: 'toolUse',
    executionId,
    streamId,
    agentConfig: CONFIG,
    shared,
    sourceShared: sourceShared ?? structuredClone(shared),
  };
}

async function runPersistedFlow(
  executionId: ExecutionId,
  streamId: StreamTabId,
  resume: ToolUseResumeData | undefined,
  onSetup?: ToolUseFlowSetupCallback,
  session: SessionHandle = createTestSession(),
  options: {
    readonly isSubagent?: boolean;
    readonly onIdle?: () => void;
    readonly takePendingFollowUps?: RunToolUseFlowInput['takePendingFollowUps'];
    readonly onFlowRecordDisposition?: (
      disposition: 'preserve' | 'delete',
    ) => void;
  } = {},
): Promise<RunToolUseFlowResult> {
  const config = resume?.agentConfig ?? CONFIG;
  const userVarChannels = resume?.shared.stateSlices.userChannels ?? {
    input: Object.freeze({ MODEL: config.model }),
    transient: {},
  };
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => config.model,
    runScope: createRunScope({
      runtimeHost: noopAgentRuntimeHost,
      streamId,
      executionId,
      agentName: config.agent,
      session,
    }),
  });
  let interrupted = false;

  try {
    return await withRunContext(context, () =>
      runToolUseFlow(
        {
          config,
          setting: TOOL_USE_SETTING,
          prompt: TOOL_USE_PROMPT,
          logger: noopTrace,
          userVarChannels,
          modelHandler: createTaggedModelHandler(ACTIVE_COMPATIBILITY_KEY),
          checkInterruption: () => interrupted,
          onInterrupt: () => {
            interrupted = true;
          },
          setAbortController: () => {},
          onRoundFinalized: () => {},
          ...(resume !== undefined && { resume }),
          isSubagent: options.isSubagent ?? true,
          onIdle: options.onIdle,
          takePendingFollowUps: options.takePendingFollowUps,
          onFlowRecordDisposition: options.onFlowRecordDisposition,
          toolInjections: new ToolInjectionRegistry(),
        },
        new MapToolRegistry({}),
        onSetup,
      ),
    );
  } finally {
    session.dispose();
  }
}

async function runResumedFlowToWaiting(
  executionId: ExecutionId,
  streamId: StreamTabId,
  resume: ToolUseResumeData,
): Promise<void> {
  const result = await runPersistedFlow(executionId, streamId, resume);
  expect(result.outcome).toBe(STREAM_PHASE.WAITING);
}

describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('rejects malformed fields at the shared-state boundary', () => {
    expect(
      migrateSharedState({
        messages: [],
        shouldSkipCycle: 'false',
        stateSlices: null,
      }),
    ).toEqual({
      success: false,
      error: expect.objectContaining({ name: 'ZodError' }),
    });
  });

  it('preserves structured output at the persisted shared-state boundary', () => {
    const result = migrateSharedState({
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
      structured: { title: 'Durable result' },
    });

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        structured: { title: 'Durable result' },
      }),
      migrated: false,
    });
  });

  it('uses the persisted current model while preserving the original stream id', async () => {
    const executionId = 'abc123' as ExecutionId;
    const streamId = 'chat@gpt54#abc123' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [],
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices('gpt54', { MODEL: 'gpt55' }),
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.streamId).toBe(streamId);
    expect(resume.agentConfig.model).toBe('gpt55');
  });

  it('preserves a recovered parent stream id in tool-use snapshots', async () => {
    const executionId = 'abc131' as ExecutionId;
    const streamId = 'chat@gpt54#abc131-child' as StreamTabId;
    const parentStreamId = 'chat@gpt54#abc131-parent' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [],
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
      { parentStreamId },
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.parentStreamId).toBe(parentStreamId);
  });

  it('infers the legacy Google GenAI handler for old Google Content transcripts', async () => {
    const executionId = 'abc124' as ExecutionId;
    const streamId = 'chat@gemini35f#abc124' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [
          {
            role: 'user',
            parts: [{ text: 'Continue the old chat transcript.' }],
          },
        ],
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices('gemini35f'),
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(GOOGLE_CONFIG),
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.shared.modelHandlerCompatibilityKey).toBe(
      'ModelHandlerGoogleGenAI',
    );
  });

  it('normalizes legacy nested conversation shared state for tool-use resume', async () => {
    const executionId = 'abc128' as ExecutionId;
    const streamId = 'chat@gpt54#abc128' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        state: {
          conversation: [
            {
              role: 'user',
              content: 'Continue the legacy conversation.',
            },
          ],
          shouldSkipCycle: false,
          stateSlices: defaultStateSlices(),
        },
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.shared.messages).toEqual([
      {
        role: 'user',
        content: 'Continue the legacy conversation.',
      },
    ]);
  });

  it('falls back to a flat legacy conversation when messages is invalid', async () => {
    // Distinct from the nested `{ state: { conversation } }` case above: this
    // is the flat (unwrapped) legacy shape -- `conversation` at the top level
    // of `shared`, never renamed to `messages`.
    const executionId = 'abc133' as ExecutionId;
    const streamId = 'chat@gpt54#abc133' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: null,
        conversation: [
          { role: 'user', content: 'Continue the flat legacy conversation.' },
        ],
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.shared.messages).toEqual([
      { role: 'user', content: 'Continue the flat legacy conversation.' },
    ]);
  });

  it('throws when resumable tool-use storage cannot be read', async () => {
    const executionId = 'abc129' as ExecutionId;
    const streamId = 'chat@gpt54#abc129' as StreamTabId;
    const store = getExecutionStore(executionId);
    await store.write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [],
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });
    const originalRead = store.read.bind(store);
    const readSpy = vi.spyOn(store, 'read').mockImplementation(async (key) => {
      if (key === flowKey(executionId)) {
        throw new Error('KV timeout');
      }
      return originalRead(key);
    });

    try {
      await expect(
        retrieveSessionResumeData(
          streamId,
          executionId,
          agentConfigToTaskState(CONFIG),
        ),
      ).rejects.toThrow(
        `Failed to retrieve tool-use resume data for stream: ${streamId}`,
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it('throws when tool-use metadata is invalid even if the flow record is valid', async () => {
    const executionId = 'abc130' as ExecutionId;
    const streamId = 'chat@gpt54#abc130' as StreamTabId;
    const store = getExecutionStore(executionId);
    await store.write('meta', {
      schemaVersion: 999,
      timestamp: '2026-07-05T00:00:00.000Z',
    });
    await store.write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [],
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    await expect(
      retrieveSessionResumeData(
        streamId,
        executionId,
        agentConfigToTaskState(CONFIG),
      ),
    ).rejects.toThrow(
      `Failed to retrieve tool-use resume data for stream: ${streamId}`,
    );
  });

  it('infers the legacy Google GenAI handler for old workflow transcripts', async () => {
    const executionId = 'abc125' as ExecutionId;
    const streamId = 'workflow@gemini35f#abc125' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        currentRound: 1,
        totalRounds: 2,
        conversation: [
          {
            role: 'user',
            parts: [{ text: 'Continue the old workflow transcript.' }],
          },
        ],
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(GOOGLE_WORKFLOW_CONFIG),
    );

    expect(resume?.type).toBe('workflow');
    if (resume?.type !== 'workflow') return;
    expect(resume.modelHandlerCompatibilityKey).toBe('ModelHandlerGoogleGenAI');
  });

  it('normalizes legacy workflow messages shared state for resume routing', async () => {
    const executionId = 'abc132' as ExecutionId;
    const streamId = 'workflow@gemini35f#abc132' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        currentRound: 1,
        totalRounds: 2,
        messages: [
          {
            role: 'user',
            parts: [{ text: 'Continue the old workflow messages.' }],
          },
        ],
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(GOOGLE_WORKFLOW_CONFIG),
    );

    expect(resume?.type).toBe('workflow');
    if (resume?.type !== 'workflow') return;
    expect(resume.modelHandlerCompatibilityKey).toBe('ModelHandlerGoogleGenAI');
  });
});

describe('runToolUseFlow consumes the resume boundary instead of re-parsing', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('creates fresh shared state when the flow record is absent', async () => {
    const executionId = 'abc-flow-absent' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-absent' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);

    const result = await runPersistedFlow(executionId, streamId, snapshot);

    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
    const stored = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );
    expect(ToolUseRunSharedCanonicalSchema.parse(stored?.shared)).toMatchObject(
      {
        messages: snapshot.shared.messages,
        stateSlices: snapshot.shared.stateSlices,
      },
    );
  });

  it('offers queue ownership again after a resumed subagent parks', async () => {
    const executionId = 'abc-flow-post-park-owner' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-post-park-owner' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const boundaryEvents: string[] = [];
    const takePendingFollowUps = vi.fn(() => {
      boundaryEvents.push('take');
      return [];
    });

    const result = await runPersistedFlow(
      executionId,
      streamId,
      snapshot,
      () => {
        boundaryEvents.push('attach');
        return () => boundaryEvents.push('detach');
      },
      undefined,
      { takePendingFollowUps },
    );

    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
    expect(takePendingFollowUps).toHaveBeenCalledTimes(2);
    expect(boundaryEvents).toEqual(['attach', 'take', 'detach', 'take']);
  });

  it('releases follow-ups while preserving the record after a persistence read failure', async () => {
    for (const resume of [true, false]) {
      const suffix = resume ? 'resume' : 'fresh';
      const executionId = `abc-flow-read-failure-${suffix}` as ExecutionId;
      const streamId =
        `chat@gpt54#abc-flow-read-failure-${suffix}` as StreamTabId;
      const snapshot = resume
        ? buildToolUseResumeData(executionId, streamId)
        : undefined;
      const store = getExecutionStore(executionId);
      const session = createTestSession();
      const readFailure = new Error('flow storage unavailable');
      const readSpy = vi
        .spyOn(store, 'read')
        .mockRejectedValueOnce(readFailure);
      const deleteSpy = vi.spyOn(store, 'delete');

      try {
        await expect(
          runPersistedFlow(
            executionId,
            streamId,
            snapshot,
            (context) => {
              context.session.appendFollowUp({
                text: 'queued before recovery',
              });
            },
            session,
          ),
        ).rejects.toMatchObject({
          name: PersistedFlowStateError.name,
          reason: 'read-failed',
          cause: readFailure,
        });
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(session.followUps.getAll(streamId)).toEqual([]);
      } finally {
        readSpy.mockRestore();
        deleteSpy.mockRestore();
        session.followUps.release(streamId);
      }
    }
  });

  it.each([
    {
      name: 'invalid shared state',
      reason: 'invalid-shared',
      stored: {
        flowName: 'texra',
        shared: {
          messages: [],
          shouldSkipCycle: 'false',
          stateSlices: null,
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        nodes: [],
      },
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
        shared: VALID_TOOL_USE_SHARED,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    {
      name: 'future envelope schema version',
      reason: 'unsupported-record',
      stored: {
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION + 1,
        flowName: 'texra',
        shared: VALID_TOOL_USE_SHARED,
        createdAt: '2026-01-01T00:00:00.000Z',
        nodes: [],
      },
    },
  ])('rejects and preserves $name', async ({ name, reason, stored }) => {
    const slug = name.replaceAll(' ', '-');
    const executionId = `abc-flow-${slug}` as ExecutionId;
    const streamId = `chat@gpt54#abc-flow-${slug}` as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    await store.write(flowKey(executionId), stored);
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      const expectedError = {
        name: PersistedFlowStateError.name,
        reason,
        ...(reason !== 'invalid-shared' && {
          cause: expect.objectContaining({ name: 'ZodError' }),
        }),
      };
      await expect(
        runPersistedFlow(executionId, streamId, snapshot),
      ).rejects.toMatchObject(expectedError);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await store.read(flowKey(executionId))).toEqual(stored);
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('skips persistence recovery when setup hands off a cancellation', async () => {
    const executionId = 'abc-cancel-setup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-setup' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    const readSpy = vi.spyOn(store, 'read');
    const writeSpy = vi.spyOn(store, 'write');
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      const result = await runPersistedFlow(
        executionId,
        streamId,
        snapshot,
        (flowContext) => flowContext.interrupt(),
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(readSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('cleans up a fresh launch cancelled before persistence recovery', async () => {
    const executionId = 'abc-fresh-cancel-setup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-fresh-cancel-setup' as StreamTabId;
    const store = getExecutionStore(executionId);
    const session = createTestSession();
    const readSpy = vi.spyOn(store, 'read');
    const deleteSpy = vi.spyOn(store, 'delete');
    const releaseSpy = vi.spyOn(session.followUps, 'release');
    const dispositions: Array<'preserve' | 'delete'> = [];

    try {
      const result = await runPersistedFlow(
        executionId,
        streamId,
        undefined,
        (flowContext) => flowContext.interrupt(),
        session,
        { onFlowRecordDisposition: (value) => dispositions.push(value) },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(readSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalledWith(flowKey(executionId));
      expect(dispositions).toEqual(['delete']);
      expect(releaseSpy).toHaveBeenCalledWith(streamId);
    } finally {
      readSpy.mockRestore();
      deleteSpy.mockRestore();
      releaseSpy.mockRestore();
    }
  });

  it('skips repair writes when cancellation arrives during the recovery read', async () => {
    const executionId = 'abc-cancel-read' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-read' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;
    const readSpy = vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      flowContext?.interrupt();
      return {
        flowName: 'texra',
        params: {},
        shared: {
          messages: [],
          shouldSkipCycle: true,
          stateSlices: snapshot.shared.stateSlices,
        },
        createdAt: new Date().toISOString(),
        nodes: [],
      };
    });
    const writeSpy = vi.spyOn(store, 'write');
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      const result = await runPersistedFlow(
        executionId,
        streamId,
        snapshot,
        (context) => {
          flowContext = context;
        },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(readSpy).toHaveBeenCalledWith(flowKey(executionId));
      expect(writeSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('preserves the resumable flow after an established run is interrupted', async () => {
    const executionId = 'abc-interrupted-conversation' as ExecutionId;
    const streamId = 'chat@gpt54#abc-interrupted-conversation' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;

    const result = await runPersistedFlow(
      executionId,
      streamId,
      snapshot,
      (context) => {
        flowContext = context;
      },
      createTestSession(),
      {
        isSubagent: false,
        onIdle: () => flowContext?.interrupt(),
      },
    );

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    expect(await store.read<FlowRecord>(flowKey(executionId))).toMatchObject({
      cursor: { nextNodeId: 'start' },
      shared: { shouldSkipCycle: true },
    });
  });

  it('preserves an established flow when provider cancellation rejects the run', async () => {
    const executionId = 'abc-interrupted-provider' as ExecutionId;
    const streamId = 'chat@gpt54#abc-interrupted-provider' as StreamTabId;
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;
    const stored = {
      flowName: 'texra',
      params: {},
      shared: {
        ...VALID_TOOL_USE_SHARED,
        modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    const snapshot = buildToolUseResumeData(
      executionId,
      streamId,
      stored.shared,
    );
    await store.write(flowKey(executionId), stored);
    const abortError = new DOMException(
      'This operation was aborted',
      'AbortError',
    );
    const runSpy = vi
      .spyOn(PersistedFlow.prototype, 'run')
      .mockImplementationOnce(async () => {
        flowContext?.interrupt();
        throw abortError;
      });
    const deleteSpy = vi.spyOn(store, 'delete');
    const dispositions: Array<'preserve' | 'delete'> = [];

    try {
      await expect(
        runPersistedFlow(
          executionId,
          streamId,
          snapshot,
          (context) => {
            flowContext = context;
          },
          undefined,
          { onFlowRecordDisposition: (value) => dispositions.push(value) },
        ),
      ).rejects.toBe(abortError);
      expect(deleteSpy).not.toHaveBeenCalledWith(flowKey(executionId));
      expect(dispositions).toEqual(['preserve']);
      expect(await store.read<FlowRecord>(flowKey(executionId))).toMatchObject({
        cursor: { nextNodeId: 'start' },
        shared: { shouldSkipCycle: true },
      });
    } finally {
      runSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('preserves a follow-up appended during setup when cancellation arrives during the recovery read (issue #8049 P2)', async () => {
    // Regression: once setup attaches the live flow context, a new follow-up
    // can enter its session queue before the flow is interruptible. If an
    // external cancellation then lands while the recovery read is pending --
    // this same "cancellation during read" window as the sibling test above --
    // the early return here reports CANCELLED with the resume record preserved,
    // but previously
    // `ToolUseSessionLifecycle.interrupt()` unconditionally disposed the
    // queue (dropping the just-appended follow-up) and the finally below
    // unconditionally released it again, so neither the caller
    // (`resumeQueuedToolUseFromResumeData`, which never restores follow-ups on
    // this success path) nor a later resume could ever recover the user's
    // queued input. Fixed by routing this window's cancellation through
    // `ToolUseSessionLifecycle.interruptPreservingQueue()` (cancels the
    // pending wait without dropping queued items) and by skipping the queue
    // release in `runToolUseFlow`'s finally whenever the flow record itself
    // is preserved.
    const executionId = 'abc-cancel-followup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-followup' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    const session = createTestSession();
    let flowContext: ToolUseSetupContext | undefined;
    const readSpy = vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      // Cancellation arrives while the recovery read is pending -- after
      // setup already appended the live follow-up below.
      flowContext?.interrupt();
      return undefined;
    });

    try {
      const result = await runPersistedFlow(
        executionId,
        streamId,
        snapshot,
        (context) => {
          flowContext = context;
          context.session.appendFollowUp({ text: 'queued during resume' });
        },
        session,
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(session.followUps.getAll(streamId)).toEqual([
        'queued during resume',
      ]);
    } finally {
      readSpy.mockRestore();
      session.followUps.release(streamId);
    }
  });

  it('preserves late input when an orphaned host-resumed subagent is cancelled mid-turn', async () => {
    const executionId = 'abc-cancel-active-followup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-active-followup' as StreamTabId;
    const session = createTestSession();
    const stored = {
      flowName: 'texra',
      params: {},
      shared: {
        ...VALID_TOOL_USE_SHARED,
        modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    };
    const snapshot = buildToolUseResumeData(
      executionId,
      streamId,
      stored.shared,
    );
    await getExecutionStore(executionId).write(flowKey(executionId), stored);
    let flowContext: ToolUseSetupContext | undefined;
    const abortError = new DOMException(
      'This operation was aborted',
      'AbortError',
    );
    const runSpy = vi
      .spyOn(PersistedFlow.prototype, 'run')
      .mockImplementationOnce(async () => {
        flowContext?.session.appendFollowUp({ text: 'late active-turn input' });
        flowContext?.interrupt();
        throw abortError;
      });

    try {
      await expect(
        runPersistedFlow(
          executionId,
          streamId,
          snapshot,
          (context) => {
            flowContext = context;
          },
          session,
          { takePendingFollowUps: () => [] },
        ),
      ).rejects.toBe(abortError);
      expect(session.followUps.getAll(streamId)).toEqual([
        'late active-turn input',
      ]);
    } finally {
      runSpy.mockRestore();
      session.followUps.release(streamId);
    }
  });

  it('hydrates a legacy-shaped flow record through the single boundary, then self-heals via its canonical fields', async () => {
    const executionId = 'abc140' as ExecutionId;
    const streamId = 'chat@gpt54#abc140' as StreamTabId;
    const legacyShared = {
      state: {
        conversation: [
          { role: 'user', content: 'Continue the legacy conversation.' },
        ],
        shouldSkipCycle: false,
        // Pass-through state must survive the consumer's self-heal write.
        systemPrompt: 'You are a helpful assistant.',
        stateSlices: defaultStateSlices(),
      },
    };
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: legacyShared,
      createdAt: new Date().toISOString(),
      cursor: { nextNodeId: WAIT_NODE_CURSOR },
      nodes: [
        { action: 'default', nodeId: 'start' },
        { action: 'default', nodeId: 'start/default' },
      ],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );
    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.shared.modelHandlerCompatibilityKey).toBeUndefined();

    await runResumedFlowToWaiting(executionId, streamId, resume);

    const healedRecord = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );

    expect(healedRecord?.shared).toMatchObject({
      messages: resume.shared.messages,
      modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
      stateSlices: resume.shared.stateSlices,
      systemPrompt: 'You are a helpful assistant.',
    });
  });

  it('skips the resume self-heal write when the persisted record is already canonical (issue #8018)', async () => {
    // `resumeToolUseFromResumeData` passes the resume handoff on every
    // native-subagent turn, so the resume-branch self-heal write must not
    // fire when the persisted record already matches what would be
    // written -- otherwise every turn costs a `StorageFSKVStore` disk
    // write for a no-op overwrite of identical bytes.
    const executionId = 'abc143' as ExecutionId;
    const streamId = 'chat@gpt54#abc143' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [{ role: 'user', content: 'Continue.' }],
        modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      createdAt: new Date().toISOString(),
      cursor: { nextNodeId: WAIT_NODE_CURSOR },
      nodes: [
        { action: 'default', nodeId: 'start' },
        { action: 'default', nodeId: 'start/default' },
      ],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );
    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.shared.modelHandlerCompatibilityKey).toBe(
      ACTIVE_COMPATIBILITY_KEY,
    );

    const store = getExecutionStore(executionId);
    const writeSpy = vi.spyOn(store, 'write');
    try {
      await runResumedFlowToWaiting(executionId, streamId, resume);

      // `PersistedFlow` still legitimately persists its own node-cursor
      // progress once as the flow steps through to WAITING -- that write is
      // not under test here. What must NOT happen is a *second*, earlier
      // write from the resume-branch self-heal repairing an already-
      // canonical record. Every write the flow does make must already carry
      // the final WAITING cursor, never the pre-step one the self-heal write
      // would have produced.
      expect(writeSpy.mock.calls.length).toBeGreaterThan(0);
      for (const [, record] of writeSpy.mock.calls) {
        expect((record as FlowRecord).cursor).toEqual({
          lastAction: 'waiting',
          nextNodeId: WAIT_NODE_CURSOR,
        });
      }
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('keeps a persisted snapshot compatibility key authoritative over the active handler', async () => {
    const executionId = 'abc142' as ExecutionId;
    const streamId = 'chat@gpt54#abc142' as StreamTabId;
    const persistedCompatibilityKey = 'ModelHandlerAnthropic';
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [{ role: 'user', content: 'Continue.' }],
        modelHandlerCompatibilityKey: persistedCompatibilityKey,
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      createdAt: new Date().toISOString(),
      cursor: { nextNodeId: WAIT_NODE_CURSOR },
      nodes: [
        { action: 'default', nodeId: 'start' },
        { action: 'default', nodeId: 'start/default' },
      ],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );
    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.shared.modelHandlerCompatibilityKey).toBe(
      persistedCompatibilityKey,
    );

    await runResumedFlowToWaiting(executionId, streamId, resume);

    const healedRecord = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );
    expect(healedRecord?.shared).toMatchObject({
      modelHandlerCompatibilityKey: persistedCompatibilityKey,
    });
  });

  it.each([
    { name: 'direct stored-state recovery', withResume: false },
    { name: 'retrieved canonical resume', withResume: true },
  ])(
    'migrates a legacy workspace before strict validation: $name',
    async ({ withResume }) => {
      const suffix = withResume ? 'retrieved' : 'stored';
      const executionId = `abc141-${suffix}` as ExecutionId;
      const streamId = `chat@gpt54#abc141-${suffix}` as StreamTabId;
      const legacyWorkspaceSnapshot = {
        todos: [
          {
            content: 'Ship the fix',
            status: 'in_progress',
            activeForm: 'Shipping the fix',
          },
        ],
        plan: { objective: 'Migrate legacy workspace snapshots on resume' },
      };
      await getExecutionStore(executionId).write(flowKey(executionId), {
        flowName: 'texra',
        params: {},
        shared: {
          messages: [{ role: 'user', content: 'Continue.' }],
          shouldSkipCycle: true,
          stateSlices: {
            runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
            workspaceSnapshot: legacyWorkspaceSnapshot,
            userChannels: {
              input: Object.freeze({ MODEL: 'gpt54' }),
              transient: {},
            },
          },
        },
        createdAt: new Date().toISOString(),
        cursor: { nextNodeId: 'start/default' },
        nodes: [{ action: 'default', nodeId: 'start' }],
      });

      const retrieved = withResume
        ? await retrieveSessionResumeData(
            streamId,
            executionId,
            agentConfigToTaskState(CONFIG),
          )
        : undefined;
      const resume = retrieved?.type === 'toolUse' ? retrieved : undefined;
      if (withResume) expect(resume).toBeDefined();
      const result = await runPersistedFlow(executionId, streamId, resume);
      expect(result.outcome).toBe(STREAM_PHASE.WAITING);

      const healedRecord = await getExecutionStore(
        executionId,
      ).read<FlowRecord>(flowKey(executionId));
      const healedShared = ToolUseRunSharedCanonicalSchema.parse(
        healedRecord?.shared,
      );
      expect(healedShared.stateSlices).not.toBeNull();
      if (!healedShared.stateSlices) return;
      const workspaceState = AgentWorkspaceState.fromCanonicalSnapshot(
        healedShared.stateSlices.workspaceSnapshot,
      );
      expect(workspaceState.workPlan.todos).toEqual(
        legacyWorkspaceSnapshot.todos,
      );
      expect(workspaceState.workPlan.plan).toEqual(
        legacyWorkspaceSnapshot.plan,
      );
    },
  );
});

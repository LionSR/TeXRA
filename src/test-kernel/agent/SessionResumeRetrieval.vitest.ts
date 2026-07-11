import { describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
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
import {
  AgentWorkspaceState,
  type AgentWorkspaceSnapshot,
} from '@agent/core/state/AgentWorkspaceState';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import {
  buildResumedSharedFromSnapshot,
  normalizeResumedWorkspaceSnapshot,
  runToolUseFlow,
  type RunToolUseFlowInput,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import { migrateSharedState } from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

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

async function runResumedFlowToWaiting(
  executionId: ExecutionId,
  streamId: StreamTabId,
  snapshot: ToolUseSessionSnapshot,
): Promise<void> {
  const session = new SessionHandle();
  const context = createRunContext({
    modelSource: 'live',
    getModel: () => snapshot.agentConfig.model,
    runScope: createRunScope({
      runtimeHost: noopAgentRuntimeHost,
      streamId,
      executionId,
      agentName: snapshot.agentConfig.agent,
      session,
    }),
  });

  try {
    const result = await withRunContext(context, () =>
      runToolUseFlow(
        {
          config: snapshot.agentConfig,
          setting: TOOL_USE_SETTING,
          prompt: TOOL_USE_PROMPT,
          logger: noopTrace,
          userVarChannels: snapshot.user,
          modelHandler: createTaggedModelHandler(ACTIVE_COMPATIBILITY_KEY),
          streamStatus: session.status,
          checkInterruption: () => false,
          setAbortController: () => {},
          resumeSnapshot: snapshot,
          isSubagent: true,
          toolInjections: new ToolInjectionRegistry(),
        },
        new MapToolRegistry({}),
      ),
    );
    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
  } finally {
    session.dispose();
  }
}

describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('uses the persisted current model while preserving the original stream id', async () => {
    const executionId = 'abc123' as ExecutionId;
    const streamId = 'chat@gpt54#abc123' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [],
        shouldSkipCycle: false,
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: { MODEL: 'gpt55' },
          },
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
    expect(resume.snapshot.streamId).toBe(streamId);
    expect(resume.snapshot.agentConfig.model).toBe('gpt55');
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
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: {},
          },
        },
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
    expect(resume.snapshot.parentStreamId).toBe(parentStreamId);
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
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gemini35f' }),
            transient: {},
          },
        },
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
    expect(resume.snapshot.modelHandlerCompatibilityKey).toBe(
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
          stateSlices: {
            runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
            workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
            userChannels: {
              input: Object.freeze({ MODEL: 'gpt54' }),
              transient: {},
            },
          },
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
    expect(resume.snapshot.messages).toEqual([
      {
        role: 'user',
        content: 'Continue the legacy conversation.',
      },
    ]);
  });

  it('normalizes a flat legacy conversation-keyed flow record for tool-use resume', async () => {
    // Distinct from the nested `{ state: { conversation } }` case above: this
    // is the flat (unwrapped) legacy shape -- `conversation` at the top level
    // of `shared`, never renamed to `messages`.
    const executionId = 'abc133' as ExecutionId;
    const streamId = 'chat@gpt54#abc133' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        conversation: [
          { role: 'user', content: 'Continue the flat legacy conversation.' },
        ],
        shouldSkipCycle: false,
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: {},
          },
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
    expect(resume.snapshot.messages).toEqual([
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
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: {},
          },
        },
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
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: {},
          },
        },
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

  it('hydrates a legacy-shaped flow record through the single boundary, then self-heals via its canonical fields', async () => {
    const executionId = 'abc140' as ExecutionId;
    const streamId = 'chat@gpt54#abc140' as StreamTabId;
    const legacyShared = {
      state: {
        conversation: [
          { role: 'user', content: 'Continue the legacy conversation.' },
        ],
        shouldSkipCycle: false,
        // Pass-through field the boundary's ToolUseSessionSnapshot contract
        // does not carry -- must survive the consumer's self-heal write.
        systemPrompt: 'You are a helpful assistant.',
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: {},
          },
        },
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
    expect(resume.snapshot.modelHandlerCompatibilityKey).toBeUndefined();

    await runResumedFlowToWaiting(executionId, streamId, resume.snapshot);

    const healedRecord = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );

    expect(healedRecord?.shared).toMatchObject({
      messages: resume.snapshot.messages,
      modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
      stateSlices: {
        runStateSnapshot: resume.snapshot.run,
        workspaceSnapshot: resume.snapshot.workspace,
        userChannels: resume.snapshot.user,
      },
      systemPrompt: 'You are a helpful assistant.',
    });
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
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: {},
          },
        },
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
    expect(resume.snapshot.modelHandlerCompatibilityKey).toBe(
      persistedCompatibilityKey,
    );

    await runResumedFlowToWaiting(executionId, streamId, resume.snapshot);

    const healedRecord = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );
    expect(healedRecord?.shared).toMatchObject({
      modelHandlerCompatibilityKey: persistedCompatibilityKey,
    });
  });

  it('migrates a legacy top-level {todos, plan} workspace snapshot when the persisted cursor is already past ToolUsePrepareNode', async () => {
    // Regression for the codex P1 on #8005: ToolUsePrepareNode.exec() is the
    // *other* legacy-migrating hydration boundary for workspaceSnapshot, but
    // it only runs on session-init resume. A flow record whose persisted
    // cursor has already advanced past ToolUsePrepareNode (e.g. suspended
    // mid-cycle) skips that node entirely on resume -- PersistedFlow.
    // ensureRecord just reuses the existing record -- so this resume
    // boundary (SessionResumeRetrieval + runToolUseFlow's self-heal) is the
    // only place left that can migrate a pre-refactor top-level
    // `{todos, plan}` workspace snapshot before ToolUseCycleNode.prep()'s
    // canonical-only `fromCanonicalSnapshot` sees it.
    const executionId = 'abc141' as ExecutionId;
    const streamId = 'chat@gpt54#abc141' as StreamTabId;
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
        shouldSkipCycle: false,
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
      // Cursor already past ToolUsePrepareNode -- resume replays from here,
      // never touching ToolUsePrepareNode's own hydration.
      cursor: { nextNodeId: 'ToolUseCycleNode' },
      nodes: [{ action: 'default', nodeId: 'ToolUsePrepareNode' }],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );
    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;

    const structuralBase = migrateSharedState({
      messages: [{ role: 'user', content: 'Continue.' }],
      shouldSkipCycle: false,
      stateSlices: {
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
        workspaceSnapshot: legacyWorkspaceSnapshot,
        userChannels: { input: { MODEL: 'gpt54' }, transient: {} },
      },
    });
    expect(structuralBase).not.toBeNull();
    if (!structuralBase) return;

    const healed = buildResumedSharedFromSnapshot(
      structuralBase.data,
      resume.snapshot,
      undefined,
    );

    // This is exactly ToolUseCycleNode.prep()'s canonical-only re-derivation
    // -- it must not throw, and the migrated todos/plan must survive.
    const workspaceState = AgentWorkspaceState.fromCanonicalSnapshot(
      healed.stateSlices!.workspaceSnapshot,
    );
    expect(workspaceState.workPlan.todos).toEqual(
      legacyWorkspaceSnapshot.todos,
    );
    expect(workspaceState.workPlan.plan).toEqual(legacyWorkspaceSnapshot.plan);
  });

  it('normalizeResumedWorkspaceSnapshot migrates a raw legacy workspace snapshot for the no-resumeSnapshot defensive fallback', () => {
    // Regression for the codex P1 on #8005, targeted at runToolUseFlow's
    // *other* self-heal branch: a fresh launch that happens to find a
    // leftover flow record (no resumeSnapshot -- the resume boundary above
    // was never consulted) migrates/backfills locally via
    // migrateSharedState, which only unwraps the outer structural wrapper
    // and never touches the nested stateSlices.workspaceSnapshot. Without
    // normalizeResumedWorkspaceSnapshot, a legacy top-level `{todos, plan}`
    // workspace snapshot survives untouched into the self-healed record and
    // later fails ToolUseCycleNode.prep()'s canonical-only
    // fromCanonicalSnapshot, whereas the pre-#8005 fromSnapshot silently
    // migrated it.
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

    // Documents the failure mode: the raw legacy shape (what
    // migrateSharedState's untouched pass-through produces) has no
    // `workPlan` field, so the canonical-only parse throws.
    expect(() =>
      AgentWorkspaceState.fromCanonicalSnapshot(
        legacyWorkspaceSnapshot as unknown as AgentWorkspaceSnapshot,
      ),
    ).toThrow();

    const normalized = normalizeResumedWorkspaceSnapshot(
      legacyWorkspaceSnapshot,
    );
    const workspaceState =
      AgentWorkspaceState.fromCanonicalSnapshot(normalized);
    expect(workspaceState.workPlan.todos).toEqual(
      legacyWorkspaceSnapshot.todos,
    );
    expect(workspaceState.workPlan.plan).toEqual(legacyWorkspaceSnapshot.plan);

    // Idempotent: normalizing an already-canonical snapshot is a no-op pass-through.
    const canonical = AgentWorkspaceState.create().toSnapshot();
    expect(normalizeResumedWorkspaceSnapshot(canonical)).toEqual(canonical);
  });
});

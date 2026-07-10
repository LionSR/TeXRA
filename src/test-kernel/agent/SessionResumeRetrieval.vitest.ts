import { describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { flowKey } from '@agent/node/persistedFlow';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { buildResumedSharedFromSnapshot } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import { migrateSharedState } from '@agent/implementations/flows/tooluse/nodes/types';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
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
    // Regression for the SessionResumeRetrieval.ts / runToolUseFlow.ts
    // duplicate-parse finding: a legacy nested-`state` record with a
    // `conversation` key and no compatibility key must migrate/validate
    // exactly once, at the resume boundary (retrieveSessionResumeData) --
    // runToolUseFlow.ts's self-heal write must consume that result's fields
    // rather than independently re-deriving them.
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
      nodes: [],
    });

    // Single boundary parse: migrate + strictly validate the legacy record.
    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );
    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;

    // runToolUseFlow.ts's own read of the same bytes: only the structural
    // unwrap from migrateSharedState is still needed there (to recover
    // pass-through fields the snapshot doesn't carry); the canonical
    // messages/stateSlices/modelHandlerCompatibilityKey values must come
    // from the boundary's snapshot, not from re-parsing `legacyShared` here.
    const structuralBase = migrateSharedState(legacyShared);
    expect(structuralBase).not.toBeNull();
    if (!structuralBase) return;

    const healed = buildResumedSharedFromSnapshot(
      structuralBase.data,
      resume.snapshot,
    );

    // Canonical fields match the boundary's single validated read.
    expect(healed.messages).toEqual(resume.snapshot.messages);
    expect(healed.stateSlices).toEqual({
      runStateSnapshot: resume.snapshot.run,
      workspaceSnapshot: resume.snapshot.workspace,
      userChannels: resume.snapshot.user,
    });
    expect(healed.modelHandlerCompatibilityKey).toBe(
      resume.snapshot.modelHandlerCompatibilityKey,
    );
    // Pass-through field outside the snapshot's contract survives.
    expect(healed.systemPrompt).toBe('You are a helpful assistant.');
  });
});

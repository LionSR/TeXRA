// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  ProgressFactApplier,
  type GetProgressStreamControls,
} from '@controllers/progressView/backend/events/ProgressFactApplier';
import { ProgressViewState } from '@controllers/progressView/backend/ProgressViewState';
import type { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import type { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import type {
  ActiveChildInfo,
  CompileFailure,
  FileLocation,
  OutputFileInfo,
  Plan,
  StorageKey,
  StreamTabId,
  SyncStreamContentPayload,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';
import { snapshotFacts } from '@test/support/storeTestDrivers';

const todo: TodoItem = {
  content: 'Hydrate work-plan state',
  status: 'pending',
  activeForm: 'Hydrating work-plan state',
};

const plan: Plan = {
  objective: [
    'Hydrate plan and todo state from one backend owner.',
    '',
    'Read todos and plan from ProgressViewState.workPlan.',
  ].join('\n'),
};

const stream = 'stream:shared-snapshot' as StreamTabId;
const parentStream = 'stream:parent' as StreamTabId;
const runId = 'run-1' as StorageKey;
const activeSubagent: ActiveChildInfo = {
  executionId: 'child-1',
  agentName: 'search',
  identity: { kind: 'agent' as const, agent: 'search' },
  childStreamId: 'stream:child',
};

function workspaceFile(relativePath: string): FileLocation {
  return {
    kind: 'workspace',
    absolutePath: `/workspace/${relativePath}`,
    relativePath,
  };
}

const usage: TokenUsageStats = {
  inputTokens: 120,
  outputTokens: 40,
  cost: 0.16,
};

const outputFile: OutputFileInfo = {
  source: 'document',
  location: workspaceFile('paper.tex'),
  round: 1,
  lineage: null,
  diff: null,
};

const compileFailure: CompileFailure = {
  round: 1,
  displayName: 'paper.tex',
  output: workspaceFile('paper.pdf'),
  log: workspaceFile('paper.log'),
  logRelativePath: 'paper.log',
};

interface SyncHarness {
  state: ProgressViewState;
  messages: SyncStreamContentPayload[];
  bridge: WebviewBridge;
  handler: ProgressFactApplier;
}

async function createSyncHarness(
  getControls?: GetProgressStreamControls,
): Promise<SyncHarness> {
  const state = new ProgressViewState(new FakeStateStore());
  await state.snapshots.load([]);
  const messages: SyncStreamContentPayload[] = [];
  const updater = {
    isAvailable: () => true,
    sendSyncStreamContent: (payload: SyncStreamContentPayload) => {
      messages.push(payload);
    },
  } as unknown as WebviewUpdater;
  const bridge = {
    syncStream: vi.fn(),
    clearAll: vi.fn(),
  } as unknown as WebviewBridge;
  const handler = new ProgressFactApplier(
    state,
    updater,
    bridge,
    () => false,
    vi.fn(),
    getControls,
  );
  return { state, messages, bridge, handler };
}

describe('progress view stream-content projection', () => {
  it('projects the tool-use snapshot and active state', async () => {
    const { state, messages, bridge, handler } = await createSyncHarness();

    snapshotFacts(state.snapshots).addUsage(stream, runId, usage);
    snapshotFacts(state.snapshots).setTodos(stream, [todo]);
    snapshotFacts(state.snapshots).setPlan(stream, plan);
    snapshotFacts(state.snapshots).setParentStream(stream, parentStream);
    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.ToolUse,
    });
    state.getOrCreateStreamState(stream, AgentCategory.ToolUse);
    state.updateStreamState(stream, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 5 },
      roundStage: { index: 2 },
      subagents: [activeSubagent],
    }));

    handler.syncStreamContent(stream, { includeActiveState: true });

    expect(bridge.syncStream).toHaveBeenCalledWith(stream);
    expect(messages.at(-1)).toMatchObject({
      stream,
      action: 'render',
      category: AgentCategory.ToolUse,
      runUsage: {
        [runId]: usage,
      },
      workPlan: {
        todos: [todo],
        plan,
        queuedFollowUps: [],
      },
      controls: {
        toolEditBypass: false,
        superYoloBypass: false,
        goal: { active: false },
      },
      activeState: {
        conversationProgress: { toolCallCount: 5 },
        roundStage: { index: 2 },
        // All-or-nothing: a tool-use run has no phase, and the slot is still
        // sent so a tab switch clears whatever the frontend had cached.
        phaseStage: null,
        badges: {
          subagents: [activeSubagent],
        },
      },
    });
    expect(state.snapshots.getWorkPlan(stream)).toEqual({
      todos: [todo],
      plan,
      planSummary: 'Hydrate plan and todo state from one backend owner.',
    });
  });

  it('projects the phase stage of a workflow-script run', async () => {
    const { state, messages, handler } = await createSyncHarness();

    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });
    state.getOrCreateStreamState(stream, AgentCategory.Workflow);
    state.updateStreamState(stream, (prev) => ({
      ...prev,
      phaseStage: { label: 'Reduce', index: 1, total: 3 },
    }));

    handler.syncStreamContent(stream, { includeActiveState: true });

    expect(messages.at(-1)).toMatchObject({
      stream,
      action: 'render',
      category: AgentCategory.Workflow,
      activeState: {
        roundStage: null,
        phaseStage: { label: 'Reduce', index: 1, total: 3 },
      },
    });
  });

  it('projects workflow outputs without tool-use capabilities', async () => {
    const { state, messages, handler } = await createSyncHarness();

    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });
    snapshotFacts(state.snapshots).addOutputFiles(stream, { 1: [outputFile] });
    snapshotFacts(state.snapshots).updateMissingOutputs(stream, {
      1: ['paper.pdf'],
    });
    snapshotFacts(state.snapshots).updateCompileFailures(stream, {
      1: [compileFailure],
    });
    snapshotFacts(state.snapshots).addUsage(stream, runId, usage);

    handler.syncStreamContent(stream);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      action: 'render',
      stream,
      category: AgentCategory.Workflow,
      runUsage: { [runId]: usage },
      outputs: {
        files: { 1: [outputFile] },
        missing: { 1: ['paper.pdf'] },
        compileFailures: { 1: [compileFailure] },
      },
    });
    expect(messages[0]).not.toHaveProperty('workPlan');
    expect(messages[0]).not.toHaveProperty('controls');
  });

  it('preserves a provisional tool-use execution across metadata reset', async () => {
    const { state, messages, handler } = await createSyncHarness();

    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.ToolUse,
    });
    // Running-transition setup preserves the provisional kind in execution
    // state while reset metadata awaits a canonical run config.
    state.resetStreamMetadataForRun(stream);
    state.getOrCreateStreamState(stream, AgentCategory.ToolUse);
    expect(state.getStreamMetadata(stream).agentCategory).toBeUndefined();
    state.updateStreamState(stream, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 3 },
      subagents: [activeSubagent],
    }));
    messages.length = 0;

    handler.syncStreamContent(stream, { includeActiveState: true });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      action: 'render',
      stream,
      category: AgentCategory.ToolUse,
      activeState: {
        conversationProgress: { toolCallCount: 3 },
        badges: { subagents: [activeSubagent] },
      },
    });
  });

  it('projects clear without placeholder stream content', async () => {
    const { messages, handler } = await createSyncHarness();

    handler.syncStreamContent('');

    expect(messages).toEqual([{ action: 'clear' }]);
  });

  it('includes host-provided stream controls in synced content', async () => {
    const controlledStream = 'stream:controls' as StreamTabId;
    const { state, messages, handler } = await createSyncHarness((streamId) => {
      expect(streamId).toBe(controlledStream);
      return {
        bashBypass: true,
        toolEditBypass: true,
        superYoloBypass: true,
        goalActive: true,
        goalStatus: 'active',
        goalObjective: 'Keep making progress.',
      };
    });

    state.updateStreamMetadata(controlledStream, {
      agentCategory: AgentCategory.ToolUse,
    });

    handler.syncStreamContent(controlledStream);

    expect(messages.at(-1)).toMatchObject({
      stream: controlledStream,
      action: 'render',
      category: AgentCategory.ToolUse,
      controls: {
        toolEditBypass: true,
        superYoloBypass: true,
        goal: {
          active: true,
          status: 'active',
          objective: 'Keep making progress.',
        },
      },
    });
  });
});

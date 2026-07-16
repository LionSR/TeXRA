// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { ProgressFactApplier } from '@controllers/progressView/backend/events/ProgressFactApplier';
import { ProgressViewState } from '@controllers/progressView/backend/state/ProgressViewState';
import { AgentCategory } from '@shared/schemas';
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
import type { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';
import type { MementoStorage } from '@controllers/progressView/backend/persistence/PersistentMapManager';
import type { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';

class MemoryMementoStorage implements MementoStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  update<T>(key: string, value: T): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

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
  kind: 'subagent',
  executionId: 'child-1',
  agentName: 'search',
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

async function createLoadedState(): Promise<ProgressViewState> {
  const state = new ProgressViewState(new MemoryMementoStorage());
  await state.snapshots.load([]);
  return state;
}

interface SyncCapture {
  messages: SyncStreamContentPayload[];
  updater: WebviewUpdater;
  bridge: WebviewBridge;
}

function createSyncCapture(): SyncCapture {
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
  return { messages, updater, bridge };
}

describe('progress view stream-content projection', () => {
  it('projects the tool-use snapshot and active state', async () => {
    const state = await createLoadedState();
    const { messages, updater, bridge } = createSyncCapture();
    const handler = new ProgressFactApplier(
      state,
      updater,
      bridge,
      () => false,
    );

    state.snapshots.addUsage(stream, runId, usage);
    state.snapshots.setTodos(stream, [todo]);
    state.snapshots.setPlan(stream, plan);
    state.setStreamParent(stream, parentStream);
    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.ToolUse,
    });
    state.getOrCreateStreamState(stream, AgentCategory.ToolUse);
    state.updateStreamState(stream, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 5 },
      roundStage: { index: 2 },
      activeSubagents: [activeSubagent],
      finishedSubagentCount: 2,
    }));

    handler.syncStreamContent(stream, { includeActiveState: true });

    expect(bridge.syncStream).toHaveBeenCalledWith(stream);
    expect(messages.at(-1)).toMatchObject({
      stream,
      action: 'render',
      kind: AgentCategory.ToolUse,
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
        badges: {
          activeSubagents: [activeSubagent],
          finishedSubagentCount: 2,
          activeProcesses: [],
          finishedProcessCount: 0,
        },
        parentStreamId: parentStream,
      },
    });
    expect(state.snapshots.getWorkPlan(stream)).toEqual({
      todos: [todo],
      plan,
      planSummary: 'Hydrate plan and todo state from one backend owner.',
    });
  });

  it('projects workflow outputs without tool-use capabilities', async () => {
    const state = await createLoadedState();
    const { messages, updater, bridge } = createSyncCapture();
    const handler = new ProgressFactApplier(
      state,
      updater,
      bridge,
      () => false,
    );

    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });
    state.snapshots.addOutputFiles(stream, { 1: [outputFile] });
    state.snapshots.updateMissingOutputs(stream, { 1: ['paper.pdf'] });
    state.snapshots.updateCompileFailures(stream, { 1: [compileFailure] });
    state.snapshots.addUsage(stream, runId, usage);

    handler.syncStreamContent(stream);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      action: 'render',
      stream,
      kind: AgentCategory.Workflow,
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

  it('projects clear without placeholder stream content', async () => {
    const state = await createLoadedState();
    const { messages, updater, bridge } = createSyncCapture();
    const handler = new ProgressFactApplier(
      state,
      updater,
      bridge,
      () => false,
    );

    handler.syncStreamContent('');

    expect(messages).toEqual([{ action: 'clear' }]);
  });

  it('includes host-provided stream controls in synced content', async () => {
    const state = await createLoadedState();
    const { messages, updater, bridge } = createSyncCapture();
    const controlledStream = 'stream:controls' as StreamTabId;
    const handler = new ProgressFactApplier(
      state,
      updater,
      bridge,
      () => false,
      (streamId) => {
        expect(streamId).toBe(controlledStream);
        return {
          toolEditBypass: true,
          superYoloBypass: true,
          goalActive: true,
          goalStatus: 'active',
          goalObjective: 'Keep making progress.',
        };
      },
    );

    state.updateStreamMetadata(controlledStream, {
      agentCategory: AgentCategory.ToolUse,
    });

    handler.syncStreamContent(controlledStream);

    expect(messages.at(-1)).toMatchObject({
      stream: controlledStream,
      action: 'render',
      kind: AgentCategory.ToolUse,
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

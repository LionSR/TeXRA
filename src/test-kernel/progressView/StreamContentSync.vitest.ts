// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { LitSessionRenderer } from '@controllers/progressView/backend/LitSessionRenderer';
import { ProgressStreamProjectionBuilder } from '@controllers/progressView/backend/ProgressStreamProjectionBuilder';
import type { GetProgressStreamControls } from '@controllers/progressView/progressStreamControls';
import type { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import { SessionState } from '@controllers/session/SessionState';
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
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
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
    'Read todos and plan from SessionState work-plan snapshot.',
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
  state: SessionState;
  messages: SyncStreamContentPayload[];
  bridge: WebviewBridge;
  renderer: LitSessionRenderer;
}

async function createSyncHarness(
  getControls?: GetProgressStreamControls,
): Promise<SyncHarness> {
  const state = new SessionState();
  await state.snapshots.load([]);
  const messages: SyncStreamContentPayload[] = [];
  const bridge = {
    syncStream: vi.fn(),
    clearAll: vi.fn(),
  } as unknown as WebviewBridge;
  const projections = new ProgressStreamProjectionBuilder(state, getControls);
  const renderer = new LitSessionRenderer(
    projections,
    state.snapshots,
    state.followUps,
    bridge,
    (message) => {
      if (message.command !== PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT) {
        return;
      }
      const { command: _command, ...payload } = message;
      messages.push(payload);
    },
    () => true,
  );
  return { state, messages, bridge, renderer };
}

describe('progress view stream-content projection', () => {
  it('projects the tool-use snapshot and active state', async () => {
    const { state, messages, bridge, renderer } = await createSyncHarness();

    const facts = snapshotFacts(state.snapshots);
    facts.addUsage(stream, runId, usage);
    facts.setTodos(stream, [todo]);
    facts.setPlan(stream, plan);
    facts.setParentStream(stream, parentStream);
    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.ToolUse,
    });
    state.getOrCreateStreamState(stream, AgentCategory.ToolUse);
    state.updateStreamState(stream, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 5 },
      stage: { kind: 'round', index: 2 },
      subagents: [activeSubagent],
    }));

    renderer.syncStreamContent(stream, { includeActiveState: true });

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
        stage: { kind: 'round', index: 2 },
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
    const { state, messages, renderer } = await createSyncHarness();

    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });
    state.getOrCreateStreamState(stream, AgentCategory.Workflow);
    state.updateStreamState(stream, (prev) => ({
      ...prev,
      stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
    }));

    renderer.syncStreamContent(stream, { includeActiveState: true });

    expect(messages.at(-1)).toMatchObject({
      stream,
      action: 'render',
      category: AgentCategory.Workflow,
      activeState: {
        stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
      },
    });
  });

  it('projects workflow outputs without tool-use capabilities', async () => {
    const { state, messages, renderer } = await createSyncHarness();

    state.updateStreamMetadata(stream, {
      agentCategory: AgentCategory.Workflow,
    });
    const facts = snapshotFacts(state.snapshots);
    facts.addOutputFiles(stream, { 1: [outputFile] });
    facts.updateMissingOutputs(stream, {
      1: ['paper.pdf'],
    });
    facts.updateCompileFailures(stream, {
      1: [compileFailure],
    });
    facts.addUsage(stream, runId, usage);

    renderer.syncStreamContent(stream);

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
    const { state, messages, renderer } = await createSyncHarness();

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

    renderer.syncStreamContent(stream, { includeActiveState: true });

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
    const { messages, renderer } = await createSyncHarness();

    renderer.syncStreamContent('');

    expect(messages).toEqual([{ action: 'clear' }]);
  });

  it('includes host-provided stream controls in synced content', async () => {
    const controlledStream = 'stream:controls' as StreamTabId;
    const { state, messages, renderer } = await createSyncHarness(
      (streamId) => {
        expect(streamId).toBe(controlledStream);
        return {
          bashBypass: true,
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

    renderer.syncStreamContent(controlledStream);

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

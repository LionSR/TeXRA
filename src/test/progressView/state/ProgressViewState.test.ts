// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import { WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { WorkflowTaskState } from '@logger/TaskState';
import type { LogMessageData, TaskGroup } from '@logger/LogTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { OutputFileInfo } from '@agent/output/types';

class FakeStorage implements StateStorage {
  public readonly saved: { key: string; value: unknown }[] = [];
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.values.has(key)) {
      return this.values.get(key) as T;
    }
    return defaultValue;
  }

  update<T>(key: string, value: T): Thenable<void> {
    this.values.set(key, value);
    this.saved.push({ key, value });
    return Promise.resolve();
  }
}

describe('ProgressViewState.clearOutputState', () => {
  it('resets workflow output metadata and persists the change', () => {
    const storage = new FakeStorage();
    const state = new ProgressViewState(storage);

    const config = parseAgentConfig({
      model: 'test-model',
      agent: 'test-agent',
      instruction: 'Test instruction',
      session: {
        agentCategory: AgentCategory.Workflow,
        agentType: AgentType.Direct,
      },
      inputFile: 'main.tex',
      outputFiles: ['out.pdf'],
      useMultipleOutputs: true,
    });

    const workflowState: WorkflowTaskState = {
      agentConfig: config,
      session: {
        ...config.session!,
        agentCategory: AgentCategory.Workflow,
      },
      activeFiles: {
        input: true,
        reference: false,
        auxiliary: false,
        media: false,
        output: true,
      },
    };
    const streamId = 'stream-1';
    state.setTaskState(streamId, workflowState);

    const savesBeforeClear = storage.saved.length;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, true);

    assert.equal(storage.saved.length, savesBeforeClear + 1);
    const lastSave = storage.saved[storage.saved.length - 1];
    assert.equal(lastSave.key, WorkspaceStateKey.TASK_STATES);

    const savedState = lastSave.value as Record<string, any>;
    const storedWorkflow = savedState[streamId];
    assert.deepStrictEqual(storedWorkflow.agentConfig.outputFiles, []);
    assert.equal(storedWorkflow.agentConfig.useMultipleOutputs, false);
    assert.equal(storedWorkflow.activeFiles.output, false);
  });

  it('avoids persisting when output metadata is already cleared', () => {
    const storage = new FakeStorage();
    const state = new ProgressViewState(storage);

    const config = parseAgentConfig({
      model: 'test-model',
      agent: 'test-agent',
      instruction: 'Test instruction',
      session: {
        agentCategory: AgentCategory.Workflow,
        agentType: AgentType.Direct,
      },
      inputFile: 'main.tex',
    });

    const workflowState: WorkflowTaskState = {
      agentConfig: config,
      session: {
        ...config.session!,
        agentCategory: AgentCategory.Workflow,
      },
      activeFiles: {
        input: true,
        reference: false,
        auxiliary: false,
        media: false,
        output: false,
      },
    };
    const streamId = 'stream-2';
    state.setTaskState(streamId, workflowState);

    // Initial save happens when setting the state
    storage.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(storage.saved, []);
  });

  it('avoids persisting when outputFiles is undefined', () => {
    const storage = new FakeStorage();
    const state = new ProgressViewState(storage);

    const config = parseAgentConfig({
      model: 'test-model',
      agent: 'test-agent',
      instruction: 'Test instruction',
      session: {
        agentCategory: AgentCategory.Workflow,
        agentType: AgentType.Direct,
      },
      inputFile: 'main.tex',
      outputFiles: undefined,
    });

    const workflowState: WorkflowTaskState = {
      agentConfig: config,
      session: {
        ...config.session!,
        agentCategory: AgentCategory.Workflow,
      },
      activeFiles: {
        input: true,
        reference: false,
        auxiliary: false,
        media: false,
        output: false,
      },
    };
    const streamId = 'stream-3';
    state.setTaskState(streamId, workflowState);

    storage.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(storage.saved, []);
  });
});

describe('ProgressViewState.load', () => {
  it('restores legacy task states lacking session metadata', async () => {
    const storage = new FakeStorage();
    const state = new ProgressViewState(storage);

    const streamId = 'legacy-stream';
    const config = parseAgentConfig({
      model: 'test-model',
      agent: 'legacy-agent',
      instruction: 'Restore me',
      agentType: AgentType.Direct,
      inputFile: 'main.tex',
    });

    const legacyConfig = { ...config } as Record<string, unknown>;
    delete legacyConfig.session;

    const legacyTaskState = {
      agentConfig: legacyConfig,
      activeFiles: {
        input: true,
        reference: false,
        auxiliary: false,
        media: false,
        output: false,
      },
    };

    await storage.update(WorkspaceStateKey.TASK_STATES, {
      workflow: {
        [streamId]: legacyTaskState,
      },
    });

    storage.saved.length = 0;

    await state.load();

    const restored = state.getTaskState(streamId);
    assert.ok(restored, 'expected legacy task state to be restored');
    assert.equal(restored!.session.agentCategory, AgentCategory.Workflow);
    assert.equal(
      restored!.agentConfig.session.agentCategory,
      AgentCategory.Workflow,
    );

    const persistedEntry = storage.saved.find(
      (entry) => entry.key === WorkspaceStateKey.TASK_STATES,
    );
    assert.ok(persistedEntry, 'expected canonicalized task states to be saved');

    const serialized = persistedEntry!.value as Record<string, any>;
    assert.deepStrictEqual(Object.keys(serialized), [streamId]);
    const serializedState = serialized[streamId];
    assert.equal(serializedState.session.agentCategory, AgentCategory.Workflow);
    assert.equal(
      serializedState.agentConfig.session.agentCategory,
      AgentCategory.Workflow,
    );
  });

  it('migrates workspace-scoped progress view data saved under legacy keys', async () => {
    const storage = new FakeStorage();
    const state = new ProgressViewState(storage);
    const workspacePath = '/fake/workspace';
    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: workspacePath } },
    ] as vscode.WorkspaceFolder[];

    const streamId = 'legacy-stream';
    const groupId = 'legacy-group';

    const logEntry: LogMessageData = {
      id: 'log-1' as any,
      text: 'legacy message',
      level: 'info',
      timestamp: 1700000000000,
    };

    const taskGroup: TaskGroup = {
      id: groupId as any,
      name: 'Legacy group',
      startTime: 1700000000000,
      status: 'running',
    };

    const usage: TokenUsageStats = {
      inputTokens: 10,
      outputTokens: 5,
      cost: 1,
    };

    await storage.update(`texra.taskStates.${workspacePath}`, {
      [streamId]: {
        agentConfig: {
          model: 'test-model',
          agent: 'legacy-agent',
          instruction: 'Restore me',
          agentType: AgentType.Direct,
          agentCategory: AgentCategory.Workflow,
          inputFile: 'main.tex',
          outputFiles: [],
          useMultipleOutputs: false,
        },
        activeFiles: {
          input: true,
          reference: false,
          auxiliary: false,
          media: false,
          output: false,
        },
      },
    });

    await storage.update(`texra.logStreams.${workspacePath}`, {
      [streamId]: [logEntry],
    });

    await storage.update(`texra.logGroups.${workspacePath}`, {
      [streamId]: {
        [groupId]: taskGroup,
      },
    });

    await storage.update(`texra.outputFiles.${workspacePath}`, {
      [streamId]: {
        0: [
          {
            path: 'out.tex',
          },
        ],
      },
    });

    await storage.update(`texra.missingOutputs.${workspacePath}`, {
      [streamId]: {
        0: ['missing.tex'],
      },
    });

    await storage.update(`texra.usageStats.${workspacePath}`, {
      [streamId]: usage,
    });

    await storage.update(`texra.executionIds.${workspacePath}`, {
      [streamId]: 'exec-1',
    });

    storage.saved.length = 0;

    try {
      await state.load();
    } finally {
      (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
    }

    const messages = state.streamTabs.getMessages(streamId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'legacy message');

    const restoredGroup = state.taskGroups.getGroup(streamId, groupId);
    assert.ok(restoredGroup);
    assert.equal(restoredGroup!.name, 'Legacy group');

    const files = state.outputFiles.getFiles(streamId);
    const firstRun = files.entries().next().value;
    assert.ok(firstRun);
    const [, runRounds] = firstRun as [string, Map<number, OutputFileInfo[]>];
    const roundFiles = runRounds.get(0);
    assert.ok(roundFiles);
    assert.equal(roundFiles![0].path, 'out.tex');

    const missing = state.outputFiles.getMissingOutputs(streamId);
    const firstMissingRun = missing.entries().next().value;
    assert.ok(firstMissingRun);
    const [, missingRounds] = firstMissingRun as [
      string,
      Map<number, string[]>,
    ];
    const roundMissing = missingRounds.get(0);
    assert.ok(roundMissing);
    assert.deepStrictEqual(roundMissing, ['missing.tex']);

    const restoredUsage = state.usageStats.getStreamUsage(streamId);
    assert.ok(restoredUsage);
    assert.deepStrictEqual(restoredUsage, usage);

    const restoredTaskState = state.getTaskState(streamId);
    assert.ok(restoredTaskState);
    assert.equal(
      restoredTaskState!.session.agentCategory,
      AgentCategory.Workflow,
    );

    const executionId = state.getExecutionId(streamId);
    assert.equal(executionId, 'exec-1');

    const savedKeys = storage.saved.map((entry) => entry.key);
    assert.ok(savedKeys.includes(WorkspaceStateKey.STREAM_TABS));
    assert.ok(savedKeys.includes(WorkspaceStateKey.TASK_GROUPS));
    assert.ok(savedKeys.includes(WorkspaceStateKey.OUTPUT_FILES));
    assert.ok(savedKeys.includes(WorkspaceStateKey.MISSING_OUTPUTS));
    assert.ok(savedKeys.includes(WorkspaceStateKey.USAGE_STATS));
    assert.ok(savedKeys.includes(WorkspaceStateKey.TASK_STATES));
    assert.ok(savedKeys.includes(WorkspaceStateKey.EXECUTION_IDS));

    assert.ok(
      savedKeys.includes(`texra.logStreams.${workspacePath}`),
      'expected legacy stream key to be cleared',
    );
    assert.ok(
      savedKeys.includes(`texra.logGroups.${workspacePath}`),
      'expected legacy group key to be cleared',
    );
    assert.ok(
      savedKeys.includes(`texra.outputFiles.${workspacePath}`),
      'expected legacy output key to be cleared',
    );
    assert.ok(
      savedKeys.includes(`texra.missingOutputs.${workspacePath}`),
      'expected legacy missing output key to be cleared',
    );
    assert.ok(
      savedKeys.includes(`texra.usageStats.${workspacePath}`),
      'expected legacy usage key to be cleared',
    );
    assert.ok(
      savedKeys.includes(`texra.taskStates.${workspacePath}`),
      'expected legacy task state key to be cleared',
    );
    assert.ok(
      savedKeys.includes(`texra.executionIds.${workspacePath}`),
      'expected legacy execution id key to be cleared',
    );
  });
});

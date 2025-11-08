// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import { WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type { WorkflowTaskState } from '@logger/TaskState';

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
});

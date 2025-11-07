// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { StateStorage } from '@progressView/persistence/PersistentMapManager';
import { WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';

// Local imports - utils
import { agentConfigToTaskState } from '@utils/config';

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

    const workflowState = agentConfigToTaskState(config);
    const streamId = 'stream-1';
    state.setTaskState(streamId, workflowState);

    const savesBeforeClear = storage.saved.length;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, true);

    assert.equal(storage.saved.length, savesBeforeClear + 1);
    const lastSave = storage.saved[storage.saved.length - 1];
    assert.equal(lastSave.key, WorkspaceStateKey.TASK_STATES);

    const savedState = lastSave.value as {
      workflow: Record<string, any>;
    };
    const storedWorkflow = savedState.workflow[streamId];
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

    const workflowState = agentConfigToTaskState(config);
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

    const workflowState = agentConfigToTaskState(config);
    const streamId = 'stream-3';
    state.setTaskState(streamId, workflowState);

    storage.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(storage.saved, []);
  });
});

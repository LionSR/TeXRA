// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import {
  WorkspaceStateKey,
  type StateManager,
} from '@common/state/stateManager';

// Local imports - agent
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';

// Local imports - utils
import { agentConfigToTaskState } from '@utils/config';

class FakeStore implements StateManager {
  public readonly saved: { key: string; value: unknown }[] = [];
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    if (arguments.length === 2) {
      return defaultValue as T;
    }
    return undefined;
  }

  async update<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
    this.saved.push({ key, value });
  }
}

describe('ProgressViewState.clearOutputState', () => {
  it('resets workflow output metadata and persists the change', () => {
    const store = new FakeStore();
    const state = new ProgressViewState(store);

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

    const savesBeforeClear = store.saved.length;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, true);

    assert.equal(store.saved.length, savesBeforeClear + 1);
    const lastSave = store.saved[store.saved.length - 1];
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
    const store = new FakeStore();
    const state = new ProgressViewState(store);

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
    store.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(store.saved, []);
  });

  it('avoids persisting when outputFiles is undefined', () => {
    const store = new FakeStore();
    const state = new ProgressViewState(store);

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

    store.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(store.saved, []);
  });
});

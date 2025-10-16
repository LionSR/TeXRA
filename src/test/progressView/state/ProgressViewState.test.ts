// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { StatePersistenceManager } from '@progressView/persistence/StatePersistenceManager';
import { WorkspaceStateKey } from '@common/state/stateManager';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';

// Local imports - utils
import { agentConfigToTaskState } from '@utils/config';

class FakePersistence {
  public readonly saved: { key: string; value: unknown }[] = [];

  async load<T>(_key: string, defaultValue: T): Promise<T> {
    return defaultValue;
  }

  async save<T>(key: string, value: T): Promise<void> {
    this.saved.push({ key, value });
  }

  async delete(): Promise<void> {
    // no-op
  }

  async loadWithMigration<T>(
    _newKey: string,
    _legacyKey: string,
    defaultValue: T,
  ): Promise<T> {
    return defaultValue;
  }
}

describe('ProgressViewState.clearOutputState', () => {
  it('resets workflow output metadata and persists the change', () => {
    const persistence = new FakePersistence();
    const state = new ProgressViewState(
      persistence as unknown as StatePersistenceManager,
    );

    const config = AgentConfigSchema.parse({
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

    const workflowState = agentConfigToTaskState(config, config.session);
    const streamId = 'stream-1';
    state.setTaskState(streamId, workflowState);

    const savesBeforeClear = persistence.saved.length;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, true);

    assert.equal(persistence.saved.length, savesBeforeClear + 1);
    const lastSave = persistence.saved[persistence.saved.length - 1];
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
    const persistence = new FakePersistence();
    const state = new ProgressViewState(
      persistence as unknown as StatePersistenceManager,
    );

    const config = AgentConfigSchema.parse({
      model: 'test-model',
      agent: 'test-agent',
      instruction: 'Test instruction',
      session: {
        agentCategory: AgentCategory.Workflow,
        agentType: AgentType.Direct,
      },
      inputFile: 'main.tex',
    });

    const workflowState = agentConfigToTaskState(config, config.session);
    const streamId = 'stream-2';
    state.setTaskState(streamId, workflowState);

    // Initial save happens when setting the state
    persistence.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(persistence.saved, []);
  });
});

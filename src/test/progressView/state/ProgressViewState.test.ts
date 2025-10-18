// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { StatePersistenceManager } from '@progressView/persistence/StatePersistenceManager';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { buildStreamInfos } from '@progressView/streamInfoUtils';

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

  it('avoids persisting when outputFiles is undefined', () => {
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
      outputFiles: undefined,
    });

    const workflowState = agentConfigToTaskState(config, config.session);
    const streamId = 'stream-3';
    state.setTaskState(streamId, workflowState);

    persistence.saved.length = 0;

    const didUpdate = state.clearOutputState(streamId);
    assert.equal(didUpdate, false);
    assert.deepStrictEqual(persistence.saved, []);
  });
});

describe('ProgressViewState workflow run tracking', () => {
  it('tracks and clears active workflow group identifiers', () => {
    const persistence = new FakePersistence();
    const state = new ProgressViewState(
      persistence as unknown as StatePersistenceManager,
    );

    const streamId = 'stream-99';
    state.setActiveWorkflowGroup(streamId, 'run-1');
    assert.equal(state.getActiveWorkflowGroup(streamId), 'run-1');

    state.setActiveWorkflowGroup(streamId, undefined);
    assert.equal(state.getActiveWorkflowGroup(streamId), undefined);

    state.streamTabs.ensureStream(streamId);
    state.setActiveWorkflowGroup(streamId, 'run-2');
    state.clearStream(streamId);
    assert.equal(state.getActiveWorkflowGroup(streamId), undefined);
  });
});

describe('buildStreamInfos workflow metadata', () => {
  it('includes workflow run details and active identifiers', () => {
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

    const streamId = 'stream-workflow';
    state.streamTabs.ensureStream(streamId);
    const workflowState = agentConfigToTaskState(config, config.session);
    state.setTaskState(streamId, workflowState);

    const group = {
      id: 'run-123',
      name: 'Run: test',
      startTime: 1000,
      status: 'running',
    } as any;
    state.taskGroups.addGroup(streamId, group.id, group);
    state.setActiveWorkflowGroup(streamId, group.id);

    const infos = buildStreamInfos(state, undefined, 'all');
    const info = infos.find((entry) => entry.name === streamId);
    assert.ok(info);
    assert.equal(info?.activeWorkflowRunId, 'run-123');
    assert.ok(Array.isArray(info?.workflowRuns));
    assert.equal(info?.workflowRuns?.[0]?.id, 'run-123');
  });
});

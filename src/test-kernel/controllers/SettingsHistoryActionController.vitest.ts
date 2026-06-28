import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { SettingsHistoryActionController } from '@controllers/settingsView/SettingsHistoryActionController';
import type { RuntimeHistoryAgentConfig } from '@agent/runtime/historyCommands';
import type { RuntimeTaskState } from '@agent/runtime/executionRequests';

const CONFIG = {
  agent: 'writer',
  model: 'deepseekT',
  instruction: 'Revise the proof.',
} as RuntimeHistoryAgentConfig;

const TASK_STATE = {
  agent: 'writer',
  model: 'deepseekT',
  instruction: 'Revise the proof.',
} as unknown as RuntimeTaskState;

describe('SettingsHistoryActionController', () => {
  it('loads rerun config through the history boundary', async () => {
    const readIds: string[] = [];
    const controller = new SettingsHistoryActionController({
      readConfig: async (executionId) => {
        readIds.push(executionId);
        return CONFIG;
      },
    });

    assert.deepEqual(await controller.getRerunConfig('abc123'), {
      ok: true,
      config: CONFIG,
    });
    assert.deepEqual(readIds, ['abc123']);
  });

  it('does not build restore task state when history config is missing', async () => {
    let buildCount = 0;
    const controller = new SettingsHistoryActionController({
      readConfig: async () => null,
      buildTaskState: () => {
        buildCount += 1;
        return TASK_STATE;
      },
    });

    assert.deepEqual(await controller.getRestoreTaskState('missing'), {
      ok: false,
      reason: 'missingConfig',
    });
    assert.equal(buildCount, 0);
  });

  it('builds restore task state from the loaded history config', async () => {
    const builtFrom: RuntimeHistoryAgentConfig[] = [];
    const controller = new SettingsHistoryActionController({
      readConfig: async () => CONFIG,
      buildTaskState: (config) => {
        builtFrom.push(config);
        return TASK_STATE;
      },
    });

    assert.deepEqual(await controller.getRestoreTaskState('abc123'), {
      ok: true,
      taskState: TASK_STATE,
    });
    assert.deepEqual(builtFrom, [CONFIG]);
  });

  it('returns host-facing delete and clear outcomes', async () => {
    const controller = new SettingsHistoryActionController({
      deleteExecution: async () => ({ status: 'running' }),
      clearExecutions: async () => ({
        deletedExecutionIds: ['old-run'],
        activeExecutionIds: ['live-run'],
      }),
    });

    assert.deepEqual(await controller.deleteHistoryExecution('live-run'), {
      status: 'running',
    });
    assert.deepEqual(await controller.clearHistoryExecutions(), {
      deletedExecutionIds: ['old-run'],
      activeExecutionIds: ['live-run'],
    });
  });
});

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { TaskStateSchema } from '@agent/core/state/TaskState';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { AgentCategory } from '@shared/schemas';

describe('agentConfigToTaskState', () => {
  it('derives workflow active files from normalized file lists', () => {
    const config = AgentConfigSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: 'correct',
      model: 'sonnet46T',
      instruction: 'Polish the draft.',
      inputFiles: ['main.tex'],
      contextFiles: [],
      mediaFiles: ['figure.png'],
      outputFiles: [],
      inputFilesActive: false,
      mediaFilesActive: false,
    });

    const taskState = agentConfigToTaskState(config);

    assert.deepEqual(taskState, {
      agentConfig: config,
      activeFiles: {
        input: true,
        context: false,
        media: true,
        output: false,
      },
    });
  });

  it('keeps tool-use configs out of workflow active-file state', () => {
    const config = AgentConfigSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: 'assistant',
      model: 'sonnet46T',
      instruction: 'Check the proof.',
      inputFiles: ['main.tex'],
    });

    const taskState = agentConfigToTaskState(config);

    assert.deepEqual(taskState, { agentConfig: config });
  });

  it('accepts old tool-use task states with the removed empty session placeholder', () => {
    const config = AgentConfigSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: 'assistant',
      model: 'sonnet46T',
      instruction: 'Check the proof.',
    });

    const taskState = TaskStateSchema.parse({
      agentConfig: config,
      toolSessionState: {},
    });

    assert.deepEqual(taskState, { agentConfig: config });
  });
});

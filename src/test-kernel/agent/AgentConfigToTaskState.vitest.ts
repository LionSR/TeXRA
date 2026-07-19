// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  isToolUseTaskState,
  isWorkflowTaskState,
  TaskStateSchema,
} from '@agent/core/state/TaskState';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

// Local imports - shared

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
      toolConfig: DEFAULT_TOOL_CONFIG,
    });

    const taskState = agentConfigToTaskState(config);

    if (!isWorkflowTaskState(taskState)) {
      assert.fail('Expected a workflow task state');
    }
    assert.equal(taskState.agentConfig, config);
    assert.deepEqual(taskState.activeFiles, {
      input: true,
      context: false,
      media: true,
      output: false,
    });
  });

  it('keeps tool-use configs out of workflow active-file state', () => {
    const config = AgentConfigSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: 'assistant',
      model: 'sonnet46T',
      instruction: 'Check the proof.',
      inputFiles: ['main.tex'],
      toolConfig: DEFAULT_TOOL_CONFIG,
    });

    const taskState = agentConfigToTaskState(config);

    if (!isToolUseTaskState(taskState)) {
      assert.fail('Expected a tool-use task state');
    }
    assert.equal(taskState.agentConfig, config);
    assert.deepEqual(taskState, { agentConfig: config });
  });

  it('accepts old tool-use task states with the removed empty session placeholder', () => {
    const config = AgentConfigSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: 'assistant',
      model: 'sonnet46T',
      instruction: 'Check the proof.',
      toolConfig: DEFAULT_TOOL_CONFIG,
    });

    const taskState = TaskStateSchema.parse({
      agentConfig: config,
      toolSessionState: {},
    });

    assert.deepEqual(taskState, { agentConfig: config });
  });

  it('normalizes a legacy workflow config nested inside task state', () => {
    const taskState = TaskStateSchema.parse({
      agentConfig: {
        inputFile: 'main.tex',
      },
      activeFiles: {
        input: true,
      },
    });
    if (!isWorkflowTaskState(taskState)) {
      assert.fail('Expected a workflow task state');
    }
    assert.equal(taskState.agentConfig.agentCategory, AgentCategory.Workflow);
    assert.deepEqual(taskState.agentConfig.inputFiles, ['main.tex']);
    assert.deepEqual(taskState.activeFiles, {
      input: true,
      context: false,
      media: false,
      output: false,
    });
  });
});

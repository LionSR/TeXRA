// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - agent
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  isToolUseTaskState,
  isWorkflowTaskState,
} from '@agent/core/state/TaskState';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';

// Local imports - shared
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

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
    assert.deepEqual(taskState.toolSessionState, {});
  });

  it('tolerates minimal workflow configs from tests and legacy callers', () => {
    const config = {
      agentCategory: AgentCategory.Workflow,
      agent: 'correct',
      model: 'sonnet46T',
      inputFiles: [],
      outputFiles: [],
    } as unknown as AgentConfig;

    const taskState = agentConfigToTaskState(config);

    if (!isWorkflowTaskState(taskState)) {
      assert.fail('Expected a workflow task state');
    }
    assert.equal(taskState.agentConfig, config);
    assert.deepEqual(taskState.activeFiles, {
      input: false,
      context: false,
      media: false,
      output: false,
    });
  });
});

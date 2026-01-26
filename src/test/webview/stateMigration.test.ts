// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Local imports - common state
import { buildMainViewStateFromTaskState } from '@common/state';
import type { ToolUseTaskState, WorkflowTaskState } from '@logger/TaskState';

describe('buildMainViewStateFromTaskState', () => {
  it('maps workflow task state into persisted MainView state', () => {
    const agentConfig = AgentConfigSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: 'correct',
      model: 'gemini3p',
      instruction: 'Fix the intro section.',
      inputFile: 'main.tex',
      inputFiles: ['appendix.tex'],
      referenceFiles: ['refs.bib'],
      outputFiles: ['main.out.tex'],
      useMultipleOutputs: true,
      toolConfig: {
        autoExtractFigure: true,
        autoExtractTikzFigure: false,
        autoCompileInputPdf: true,
        attachTeXCount: true,
        attachDiagnostics: false,
      },
    });

    const taskState: WorkflowTaskState = {
      agentConfig: agentConfig as WorkflowTaskState['agentConfig'],
      activeFiles: {
        input: true,
        reference: true,
        auxiliary: false,
        media: false,
        output: true,
      },
    };

    const state = buildMainViewStateFromTaskState(taskState);
    assert.equal(state.sessionType, 'workflow');
    assert.equal(state.workflowAgent, 'correct');
    assert.equal(state.toolUseAgent, '');
    assert.equal(state.inputFile, 'main.tex');
    assert.deepEqual(state.inputFiles, ['appendix.tex']);
    assert.equal(state.inputFilesVisible, true);
    assert.equal(state.referenceFilesVisible, true);
    assert.equal(state.outputFilesVisible, true);
    assert.equal(state.outputFilesActive, true);
    assert.equal(state.autoExtractFigure, true);
    assert.equal(state.autoCompileInputPdf, true);
    assert.equal(state.attachTeXCount, true);
  });

  it('maps tool-use task state to tool-use session defaults', () => {
    const agentConfig = AgentConfigSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: 'chat',
      model: 'gemini3p',
      instruction: 'Summarize the draft.',
    });

    const taskState: ToolUseTaskState = {
      agentConfig: agentConfig as ToolUseTaskState['agentConfig'],
      toolSessionState: {},
    };
    const state = buildMainViewStateFromTaskState(taskState);

    assert.equal(state.sessionType, 'toolUse');
    assert.equal(state.toolUseAgent, 'chat');
    assert.equal(state.workflowAgent, '');
    assert.equal(state.outputFilesActive, false);
  });

  it('shows output files when restored task state includes them', () => {
    const agentConfig = AgentConfigSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: 'correct',
      model: 'gemini3p',
      instruction: 'Review the conclusion.',
      inputFile: 'main.tex',
      outputFiles: ['main.out.tex'],
    });

    const taskState: WorkflowTaskState = {
      agentConfig: agentConfig as WorkflowTaskState['agentConfig'],
      activeFiles: {
        input: true,
        reference: false,
        auxiliary: false,
        media: false,
        output: false,
      },
    };

    const state = buildMainViewStateFromTaskState(taskState);
    assert.equal(state.outputFilesVisible, true);
    assert.equal(state.outputFilesActive, true);
  });
});

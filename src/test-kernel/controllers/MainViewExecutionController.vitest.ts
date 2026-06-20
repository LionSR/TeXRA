import { describe, expect, it } from 'vitest';

import { prepareMainViewExecutionRequest } from '@controllers/mainView/MainViewExecutionController';
import { buildMainViewExecuteMessage } from '@controllers/mainView/MainViewExecutionMessageController';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

describe('MainViewExecutionController', () => {
  it('builds tool-use execute messages from form state', () => {
    expect(
      buildMainViewExecuteMessage({
        sessionType: 'toolUse',
        workflowAgent: 'correct',
        toolUseAgent: 'orchestrator',
        model: 'gpt-5.4',
        instruction: 'Solve a small enumeration problem.',
        singleFiles: { baseFile: 'old.tex', editedFile: 'new.tex' },
        multiFiles: {
          inputFiles: ['main.tex'],
          contextFiles: ['refs.bib'],
          mediaFiles: ['figure.png'],
          outputFiles: ['stale-output.tex'],
        },
        checkboxValues: {
          autoExtractFigure: true,
          autoExtractTikzFigure: false,
          autoCompileInputPdf: true,
          attachTeXCount: false,
        },
      }),
    ).toMatchObject({
      agent: 'orchestrator',
      model: 'gpt-5.4',
      instruction: 'Solve a small enumeration problem.',
      isToolUseAgent: true,
      baseFile: 'old.tex',
      editedFile: 'new.tex',
      inputFiles: ['main.tex'],
      inputFilesActive: true,
      contextFiles: ['refs.bib'],
      contextFilesActive: true,
      mediaFiles: ['figure.png'],
      mediaFilesActive: true,
      outputFiles: [],
      outputFilesActive: false,
      autoExtractFigure: true,
      autoExtractTikzFigure: false,
      autoCompileInputPdf: true,
      attachTeXCount: false,
    });
  });

  it('builds workflow execute messages with the workflow agent', () => {
    const message = buildMainViewExecuteMessage({
      sessionType: 'workflow',
      workflowAgent: 'correct',
      toolUseAgent: 'orchestrator',
      model: 'gpt-5.4',
      instruction: 'Correct this file.',
      singleFiles: { baseFile: '', editedFile: '' },
      multiFiles: {
        inputFiles: [],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
      },
      checkboxValues: {
        autoExtractFigure: false,
        autoExtractTikzFigure: false,
        autoCompileInputPdf: false,
        attachTeXCount: true,
      },
    });

    expect(message.agent).toBe('correct');
    expect(message.isToolUseAgent).toBe(false);
    expect(message.inputFilesActive).toBe(false);
  });

  it('keeps missing selections explicit before schema prefaults apply', () => {
    expect(prepareMainViewExecutionRequest({ model: 'gpt-5.4' }).valid).toBe(
      false,
    );
    expect(prepareMainViewExecutionRequest({ agent: 'direct-agent' })).toEqual({
      valid: false,
      message:
        'Agent and model selection required. Please select both before running.',
    });
  });

  it('requires an input file for workflow runs', () => {
    expect(
      prepareMainViewExecutionRequest({
        agent: 'direct-agent',
        model: 'gpt-5.4',
      }),
    ).toEqual({
      valid: false,
      message: 'Please select an input file.',
      docsCommand: 'file-management',
    });
  });

  it('normalizes UI execution fields into an agent config request', () => {
    const result = prepareMainViewExecutionRequest({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      inputFiles: ['paper/main.tex'],
      mediaFiles: ['diagram.png', null],
      attachDiagnostics: true,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.config).toMatchObject({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      inputFiles: ['paper/main.tex'],
      outputFiles: [],
      agentCategory: AgentCategory.Workflow,
      mediaFiles: ['diagram.png'],
      editedFile: null,
      toolConfig: {
        attachDiagnostics: false,
      },
    });
  });

  it('ignores stale UI output file selections', () => {
    const result = prepareMainViewExecutionRequest({
      agent: 'direct-agent',
      model: 'gpt-5.4',
      inputFiles: ['paper/main.tex'],
      outputFiles: ['paper/old-output.tex'],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.request.config.outputFiles).toEqual([]);
  });
});

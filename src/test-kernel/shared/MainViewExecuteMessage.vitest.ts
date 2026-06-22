import { describe, expect, it } from 'vitest';

import { buildMainViewExecuteMessage } from '@shared/mainView';

describe('MainView execute message builder', () => {
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
});

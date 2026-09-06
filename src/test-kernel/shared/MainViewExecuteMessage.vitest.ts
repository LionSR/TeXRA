import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@shared/schemas';
import {
  buildMainViewExecuteMessage,
  type MainViewExecutionFormState,
} from '@shared/mainView/executionFormState';

function formState(
  overrides: Partial<MainViewExecutionFormState>,
): MainViewExecutionFormState {
  return {
    sessionType: 'toolUse',
    agent: { workflow: 'correct', toolUse: 'orchestrator' },
    model: 'gpt-5.4',
    instruction: 'Solve a small enumeration problem.',
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
      attachTeXCount: false,
    },
    ...overrides,
  };
}

describe('MainView execute message builder', () => {
  it('builds tool-use execute messages from form state', () => {
    expect(
      buildMainViewExecuteMessage(
        formState({
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
      ),
    ).toMatchObject({
      agent: 'orchestrator',
      model: 'gpt-5.4',
      instruction: 'Solve a small enumeration problem.',
      agentCategory: AgentCategory.ToolUse,
      files: {
        inputFiles: ['main.tex'],
        contextFiles: ['refs.bib'],
        mediaFiles: ['figure.png'],
      },
      toolConfig: {
        autoExtractFigure: true,
        autoExtractTikzFigure: false,
        autoCompileInputPdf: true,
        attachTeXCount: false,
      },
    });
  });

  it('builds workflow execute messages with the workflow agent', () => {
    const message = buildMainViewExecuteMessage(
      formState({
        sessionType: 'workflow',
        instruction: 'Correct this file.',
        checkboxValues: {
          autoExtractFigure: false,
          autoExtractTikzFigure: false,
          autoCompileInputPdf: false,
          attachTeXCount: true,
        },
      }),
    );

    expect(message.agent).toBe('correct');
    expect(message.agentCategory).toBe(AgentCategory.Workflow);
    expect(message.files?.inputFiles).toEqual([]);
  });

  it('preserves the selected workspace root in the execute session', () => {
    const message = buildMainViewExecuteMessage(
      formState({
        instruction: 'Inspect the selected project.',
        session: {
          launchTarget: 'agent',
          workingDirectory: '/workspace/paper',
        },
      }),
    );

    expect(message.session).toEqual({
      launchTarget: 'agent',
      workingDirectory: '/workspace/paper',
    });
  });
});

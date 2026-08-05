import { describe, expect, it } from 'vitest';

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  buildMainViewExecuteMessage,
  type MainViewExecutionFormState,
} from '@shared/mainView/executionFormState';
import { AgentCategory } from '@shared/schemas/agent';
import {
  MainViewExecuteInboundMessageSchema,
  MainViewExecuteMessageSchema,
} from '@shared/schemas/mainView';

function formState(
  overrides: Partial<MainViewExecutionFormState>,
): MainViewExecutionFormState {
  return {
    sessionType: 'toolUse',
    agent: { workflow: 'correct', toolUse: 'orchestrator' },
    model: 'gpt-5.4',
    instruction: 'Solve a small enumeration problem.',
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
      ),
    ).toMatchObject({
      agent: 'orchestrator',
      model: 'gpt-5.4',
      instruction: 'Solve a small enumeration problem.',
      agentCategory: AgentCategory.ToolUse,
      files: {
        baseFile: 'old.tex',
        editedFile: 'new.tex',
        inputFiles: ['main.tex'],
        inputFilesActive: true,
        contextFiles: ['refs.bib'],
        contextFilesActive: true,
        mediaFiles: ['figure.png'],
        mediaFilesActive: true,
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
    expect(message.files?.inputFilesActive).toBe(false);
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

  it('derives execute payload validation from the shared schema', () => {
    const message = buildMainViewExecuteMessage(
      formState({
        instruction: 'Search for a short proof.',
        multiFiles: {
          inputFiles: [],
          contextFiles: [],
          mediaFiles: ['diagram.png'],
          outputFiles: [],
        },
      }),
    );

    expect(MainViewExecuteMessageSchema.parse(message)).toEqual(message);
    expect(
      MainViewExecuteInboundMessageSchema.parse({
        command: MAIN_VIEW_COMMANDS.EXECUTE,
        ...message,
      }),
    ).toMatchObject({
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'orchestrator',
      files: { mediaFiles: ['diagram.png'] },
    });
  });

  it('rejects malformed nested execute payload fields', () => {
    expect(
      MainViewExecuteInboundMessageSchema.safeParse({
        command: MAIN_VIEW_COMMANDS.EXECUTE,
        files: { inputFiles: 'main.tex' },
      }).success,
    ).toBe(false);
  });
});

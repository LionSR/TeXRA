// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared constants
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - main-view actions and state
import {
  runLatexDiffsAction,
  runPanelAction,
} from '@webview/frontend/mainViewActions';
import {
  commit$,
  model$,
  multiFiles$,
  resetMainViewState,
  sessionType$,
  singleFiles$,
  agent$,
} from '@webview/frontend/mainViewState';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

function selectFiles(inputFiles: string[], baseFile = '', editedFile = '') {
  multiFiles$.set({ ...multiFiles$.get(), inputFiles });
  singleFiles$.set({ baseFile, editedFile });
}

function information(text: string): [string, { text: string }] {
  return [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE, { text }];
}

describe('main-view direct actions', () => {
  beforeEach(() => {
    resetMainViewState();
    mocks.postMessage.mockClear();
  });

  it('posts a single-file pack followed by its information message', () => {
    sessionType$.set('workflow');
    model$.set('gpt-5.4');
    agent$.set({ ...agent$.get(), workflow: 'correct' });
    selectFiles(['main.tex']);

    runPanelAction('pack');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        MAIN_VIEW_COMMANDS.PACK_SINGLE,
        {
          inputFile: 'main.tex',
          agent: 'correct',
          model: 'gpt-5.4',
          inputFiles: undefined,
        },
      ],
      information('Packing single file: main.tex'),
    ]);
  });

  it('filters empty entries and posts a multi-file clean with the active tool-use agent', () => {
    sessionType$.set('toolUse');
    model$.set('gpt-5.4');
    agent$.set({ ...agent$.get(), toolUse: 'orchestrator' });
    selectFiles(['main.tex', '', 'chapter.tex']);

    runPanelAction('clean');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE,
        {
          inputFile: 'main.tex',
          agent: 'orchestrator',
          model: 'gpt-5.4',
          inputFiles: ['chapter.tex'],
        },
      ],
      information('Cleaning multiple files: main.tex, chapter.tex'),
    ]);
  });

  it.each([
    { inputFiles: [] as string[], model: 'gpt-5.4' },
    { inputFiles: ['main.tex'], model: '' },
  ])('rejects a pack when a required field is absent', (state) => {
    model$.set(state.model);
    selectFiles(state.inputFiles);

    runPanelAction('pack');

    expect(mocks.postMessage.mock.calls).toEqual([
      information('Choose an input file and a model first.'),
    ]);
  });

  it.each([
    {
      action: 'latexdiff' as const,
      command: MAIN_VIEW_COMMANDS.LATEXDIFF,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        editedFile: 'new.tex',
      },
      info: 'Running LaTeX diff between old.tex and new.tex',
    },
    {
      action: 'latexdiffvc' as const,
      command: MAIN_VIEW_COMMANDS.LATEXDIFFVC,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        commitHash: 'abc123',
      },
      info: 'Running LaTeX diff with version control: old.tex at commit abc123',
    },
    {
      action: 'packLatexdiffvc' as const,
      command: MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        commitHash: 'abc123',
        clean: false,
      },
      info: 'Packing LaTeX diff with version control: old.tex at commit abc123',
    },
    {
      action: 'cleanLatexdiffvc' as const,
      command: MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC,
      payload: {
        inputFile: 'main.tex',
        baseFile: 'old.tex',
        commitHash: 'abc123',
        clean: true,
      },
      info: 'Cleaning LaTeX diff with version control: old.tex at commit abc123',
    },
  ])('posts $action followed by its information message', (expected) => {
    selectFiles(['main.tex'], 'old.tex', 'new.tex');
    commit$.set('abc123');

    runLatexDiffsAction(expected.action);

    expect(mocks.postMessage.mock.calls).toEqual([
      [expected.command, expected.payload],
      information(expected.info),
    ]);
  });

  it('posts merge followed by its information message', () => {
    selectFiles(['main.tex'], 'old.tex', 'new.tex');

    runLatexDiffsAction('merge');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        MAIN_VIEW_COMMANDS.MERGE,
        { inputFile: 'main.tex', editedFile: 'new.tex' },
      ],
      information('Merging files: main.tex and new.tex'),
    ]);
  });

  it.each([
    { inputFiles: [] as string[], editedFile: 'new.tex' },
    { inputFiles: ['main.tex'], editedFile: '' },
  ])('rejects merge when either required file is absent', (state) => {
    selectFiles(state.inputFiles, 'old.tex', state.editedFile);

    runLatexDiffsAction('merge');

    expect(mocks.postMessage.mock.calls).toEqual([
      information('Choose both the input and edited files to merge.'),
    ]);
  });

  it.each([
    ['compare' as const, MAIN_VIEW_COMMANDS.COMPARE],
    ['accept' as const, MAIN_VIEW_COMMANDS.ACCEPT_EDITED],
  ])('posts the exact %s file-operation message', (action, command) => {
    selectFiles(['main.tex'], 'old.tex', 'new.tex');

    runLatexDiffsAction(action);

    expect(mocks.postMessage.mock.calls).toEqual([
      [command, { baseFile: 'old.tex', editedFile: 'new.tex' }],
    ]);
  });

  it.each([
    { baseFile: '', editedFile: 'new.tex' },
    { baseFile: 'old.tex', editedFile: '' },
  ])('rejects compare when either required file is absent', (state) => {
    selectFiles(['main.tex'], state.baseFile, state.editedFile);

    runLatexDiffsAction('compare');

    expect(mocks.postMessage.mock.calls).toEqual([
      information('Choose both the base and edited files to compare.'),
    ]);
  });
});

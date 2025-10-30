// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - constants
// @ts-ignore lack of type definitions for webview modules
import {
  ELEMENT_IDS,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
} from '@webview/modules/constants.js';

describe('MainViewState session transitions', () => {
  let dom: JSDOM;
  let persistedState: Record<string, unknown>;
  let mainViewState: any;
  let collectCurrentContext: any;

  beforeEach(async () => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost',
    });

    const { window } = dom;
    (global as any).window = window;
    (global as any).document = window.document;
    (global as any).HTMLElement = window.HTMLElement;
    (global as any).HTMLInputElement = window.HTMLInputElement;
    (global as any).Element = window.Element;
    (global as any).CustomEvent = window.CustomEvent;
    (global as any).navigator = window.navigator;

    persistedState = {};
    const api = {
      getState: () => ({ ...persistedState }),
      setState: (value: Record<string, unknown>) => {
        persistedState = { ...value };
      },
      postMessage: () => {},
    };
    (global as any).acquireVsCodeApi = () => api;

    const { document } = window;

    const sessionInput = document.createElement('input');
    sessionInput.id = SESSION_TYPE_INPUT;
    sessionInput.value = SESSION_TYPES.WORKFLOW;
    document.body.appendChild(sessionInput);

    const sessionToggle = document.createElement('div');
    sessionToggle.id = ELEMENT_IDS.SESSION_TYPE_TOGGLE;
    document.body.appendChild(sessionToggle);

    const workflowAgent = document.createElement('div');
    workflowAgent.id = 'workflowAgent';
    document.body.appendChild(workflowAgent);

    const toolUseAgent = document.createElement('div');
    toolUseAgent.id = 'toolUseAgent';
    document.body.appendChild(toolUseAgent);

    const modelInput = document.createElement('input');
    modelInput.id = 'model';
    modelInput.value = 'model';
    document.body.appendChild(modelInput);

    const instruction = document.createElement('textarea');
    instruction.id = ELEMENT_IDS.INSTRUCTION;
    instruction.value = '';
    document.body.appendChild(instruction);

    const commitInput = document.createElement('input');
    commitInput.id = ELEMENT_IDS.COMMIT_SELECT;
    commitInput.value = 'HEAD';
    document.body.appendChild(commitInput);

    const fileSelectionGroup = document.createElement('div');
    fileSelectionGroup.className = 'file-selection-group';
    document.body.appendChild(fileSelectionGroup);

    const createToggle = (id: string) => {
      const toggle = document.createElement('div');
      toggle.id = id;
      const icon = document.createElement('i');
      toggle.appendChild(icon);
      document.body.appendChild(toggle);
    };

    createToggle(ELEMENT_IDS.TOGGLE_OUTPUT_FILES);
    ['Input', 'Reference', 'Auxiliary', 'Media'].forEach((name) =>
      createToggle(`toggle${name}Files`),
    );

    const outputContainer = document.createElement('div');
    outputContainer.id = ELEMENT_IDS.OUTPUT_FILES_CONTAINER;
    outputContainer.style.display = 'block';
    const outputList = document.createElement('div');
    outputList.id = ELEMENT_IDS.OUTPUT_FILES;
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.path = 'draft.pdf';
    outputList.appendChild(fileItem);
    outputContainer.appendChild(outputList);
    fileSelectionGroup.appendChild(outputContainer);

    ['input', 'reference', 'auxiliary', 'media'].forEach((type) => {
      const single = document.createElement('input');
      single.id = `${type}File`;
      single.value = `${type}.tex`;
      document.body.appendChild(single);

      const multiContainer = document.createElement('div');
      multiContainer.id = `${type}FilesContainer`;
      multiContainer.style.display = 'none';
      const multiList = document.createElement('div');
      multiList.id = `${type}Files`;
      multiContainer.appendChild(multiList);
      fileSelectionGroup.appendChild(multiContainer);
    });

    [
      'autoExtractFigure',
      'autoExtractTikzFigure',
      'autoCompileInputPdf',
      'attachTeXCount',
      'attachDiagnostics',
    ].forEach((id) => {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = id;
      document.body.appendChild(checkbox);
    });

    const latexdiffsContent = document.createElement('div');
    latexdiffsContent.id = ELEMENT_IDS.LATEXDIFFS_CONTENT;
    latexdiffsContent.style.display = 'none';
    document.body.appendChild(latexdiffsContent);

    const latexdiffsToggle = document.createElement('div');
    latexdiffsToggle.id = ELEMENT_IDS.TOGGLE_LATEXDIFFS;
    latexdiffsToggle.appendChild(document.createElement('i'));
    document.body.appendChild(latexdiffsToggle);

    // @ts-ignore dynamic import without typings
    const mainViewModule = await import('@webview/modules/mainViewState.js');
    mainViewState = mainViewModule.mainViewState;
    // @ts-ignore dynamic import without typings
    const contextModule = await import(
      '@webview/modules/state/currentContext.js'
    );
    collectCurrentContext = contextModule.collectCurrentContext;

    mainViewState.setDefaults();

    const refreshedOutputList = document.getElementById(
      ELEMENT_IDS.OUTPUT_FILES,
    );
    if (refreshedOutputList) {
      refreshedOutputList.innerHTML = '';
      const refreshedItem = document.createElement('div');
      refreshedItem.className = 'file-item';
      refreshedItem.dataset.path = 'draft.pdf';
      refreshedOutputList.appendChild(refreshedItem);
    }
    const refreshedContainer = document.getElementById(
      ELEMENT_IDS.OUTPUT_FILES_CONTAINER,
    );
    if (refreshedContainer) {
      refreshedContainer.style.display = 'block';
    }
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).HTMLElement;
    delete (global as any).HTMLInputElement;
    delete (global as any).Element;
    delete (global as any).CustomEvent;
    delete (global as any).navigator;
    delete (global as any).acquireVsCodeApi;
  });

  it('collapses output files when switching to tool-use mode', () => {
    const outputContainer = document.getElementById(
      ELEMENT_IDS.OUTPUT_FILES_CONTAINER,
    ) as HTMLDivElement;
    const outputList = document.getElementById(
      ELEMENT_IDS.OUTPUT_FILES,
    ) as HTMLDivElement;

    const beforeChildren = outputList.children.length;
    assert.strictEqual(beforeChildren > 0, true);

    mainViewState.applySessionType(SESSION_TYPES.TOOL_USE);

    assert.strictEqual(outputContainer.style.display, 'none');
    assert.strictEqual(outputList.children.length, 0);

    const state = mainViewState.get();
    assert.strictEqual(state.outputFilesActive, false);
    assert.strictEqual(state.outputFilesVisible, false);
    assert.deepStrictEqual(state.outputFiles, []);

    const context = collectCurrentContext();
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        context.multipleFileSelections,
        ELEMENT_IDS.OUTPUT_FILES,
      ),
      false,
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        context.multipleFileSelections,
        `${ELEMENT_IDS.OUTPUT_FILES}Active`,
      ),
      false,
    );
  });
});

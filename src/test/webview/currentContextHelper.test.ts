/* eslint-env mocha */

// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

// Local imports - webview
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  ELEMENT_IDS,
} from '../../webview/modules/constants.js';
import { collectCurrentContext } from '../../webview/modules/state/currentContext.js';

type MultipleSelections = {
  [key: string]: string[] | boolean;
  inputFiles: string[];
  inputFilesActive: boolean;
  referenceFiles: string[];
  referenceFilesActive: boolean;
  outputFiles: string[];
  outputFilesActive: boolean;
};

type WebviewContext = {
  agent: string;
  sessionType: 'workflow' | 'toolUse';
  isToolUseAgent: boolean;
  singleFileSelections: Record<string, string>;
  multipleFileSelections: MultipleSelections;
  checkboxValues: Record<string, boolean>;
};

function createSelect(id: string, value: string) {
  const select = document.createElement('select');
  select.id = id;
  const option = document.createElement('option');
  option.value = value;
  option.textContent = value;
  option.selected = true;
  select.appendChild(option);
  document.body.appendChild(select);
  return select;
}

function createInput(id: string, value: string) {
  const input = document.createElement('input');
  input.id = id;
  input.value = value;
  document.body.appendChild(input);
  return input;
}

function createCheckbox(id: string, checked: boolean) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = id;
  checkbox.checked = checked;
  document.body.appendChild(checkbox);
  return checkbox;
}

function createFileList(
  id: string,
  display: 'block' | 'none',
  files: string[],
) {
  const container = document.createElement('div');
  container.id = `${id}Container`;
  container.style.display = display;
  document.body.appendChild(container);

  const list = document.createElement('div');
  list.id = id;
  container.appendChild(list);

  files.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = file;
    list.appendChild(item);
  });

  return { container, list };
}

describe('collectCurrentContext', () => {
  let dom: any;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
    (globalThis as any).HTMLSelectElement = dom.window.HTMLSelectElement;
  });

  afterEach(() => {
    dom.window.close();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).HTMLElement;
    delete (globalThis as any).HTMLInputElement;
    delete (globalThis as any).HTMLSelectElement;
  });

  function bootstrapDom(sessionType: 'workflow' | 'toolUse') {
    createInput('sessionType', sessionType);
    createSelect('workflowAgent', 'workflowAgentValue');
    createSelect('toolUseAgent', 'toolUseAgentValue');

    createInput('inputFile', 'main.tex');
    createInput('referenceFile', 'references.bib');
    createInput('auxiliaryFile', 'aux.log');
    createInput('mediaFile', 'figure.png');

    MULTIPLE_SELECTIONS.forEach((id: string) => {
      if (id === ELEMENT_IDS.OUTPUT_FILES) {
        createFileList(id, 'block', ['output.pdf']);
        return;
      }
      if (id === 'inputFiles') {
        createFileList(id, 'block', ['main.tex', 'chapter1.tex']);
        return;
      }
      createFileList(id, 'none', []);
    });

    CHECK_BOXES.forEach((id: string, index: number) => {
      createCheckbox(id, index % 2 === 0);
    });
  }

  it('aggregates workflow context including filtered single selections', () => {
    bootstrapDom('workflow');

    const context = collectCurrentContext() as WebviewContext;

    assert.equal(context.sessionType, 'workflow');
    assert.equal(context.agent, 'workflowAgentValue');
    assert.equal(context.isToolUseAgent, false);

    assert.deepEqual(context.singleFileSelections, {
      inputFile: 'main.tex',
      referenceFile: 'references.bib',
      auxiliaryFile: 'aux.log',
      mediaFile: 'figure.png',
    });

    assert.deepEqual(context.multipleFileSelections.inputFiles, [
      'chapter1.tex',
    ]);
    assert.equal(context.multipleFileSelections.inputFilesActive, true);

    assert.deepEqual(context.multipleFileSelections.outputFiles, [
      'output.pdf',
    ]);
    assert.equal(context.multipleFileSelections.outputFilesActive, true);

    CHECK_BOXES.forEach((id: string, index: number) => {
      assert.equal(context.checkboxValues[id], index % 2 === 0);
    });
  });

  it('uses tool-use agent selection and respects inactive lists', () => {
    bootstrapDom('toolUse');

    const context = collectCurrentContext() as WebviewContext;

    assert.equal(context.sessionType, 'toolUse');
    assert.equal(context.agent, 'toolUseAgentValue');
    assert.equal(context.isToolUseAgent, true);

    assert.equal(context.multipleFileSelections.referenceFilesActive, false);
    assert.deepEqual(context.multipleFileSelections.referenceFiles, []);
  });
});

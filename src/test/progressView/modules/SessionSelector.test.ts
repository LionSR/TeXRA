// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
// @ts-ignore jsdom typings not available in this environment
import { JSDOM } from 'jsdom';

// Local imports - progress view
// @ts-ignore: progress view message handler is compiled JS
import { ProgressViewMessageHandler } from '../../../progressView/modules/messageHandlers.js';
// @ts-ignore: progress view state is compiled JS
import { progressViewState } from '../../../progressView/modules/progressViewState.js';
// @ts-ignore: progress view DOM handler is compiled JS
import { progressViewDomHandler } from '../../../progressView/modules/domHandlers.js';

describe('Session selector integration', () => {
  let handler: ProgressViewMessageHandler;
  let originalDocument: typeof global.document;
  let originalWindow: any;
  let originalNavigator: any;

  beforeEach(() => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="logContent"></div>
      <div id="sessionSelectorContainer" class="session-selector">
        <label for="sessionSelector"></label>
        <select id="sessionSelector"></select>
      </div>
      <div id="instructionContainer" class="instruction-panel">
        <div class="instruction-panel__body"></div>
        <div id="instructionText"></div>
        <button id="instructionToggleBtn"></button>
        <button id="instructionCopyBtn"></button>
      </div>
      <template id="groupDetailsTemplate">
        <details class="log-group">
          <div class="log-group-content"></div>
        </details>
      </template>
      <template id="groupHeaderTemplate">
        <summary class="log-group-header">
          <span class="group-status-icon"></span>
          <span class="group-title"></span>
          <span class="group-time"></span>
        </summary>
      </template>
    </body></html>`);

    originalDocument = global.document;
    originalWindow = (global as any).window;
    originalNavigator = (global as any).navigator;

    global.document = dom.window.document as any;
    (global as any).window = dom.window as any;
    (global as any).navigator = dom.window.navigator;
    dom.window.requestAnimationFrame = (cb: any) => cb(0);

    handler = new ProgressViewMessageHandler();
    progressViewState.taskGroups.clear();
    progressViewState.selectedGroups.clear();
    progressViewState.currentGroupIds.clear();
    progressViewState.activeStream = 'stream-1';
    progressViewDomHandler.taskGroups.clear();
  });

  afterEach(() => {
    progressViewState.taskGroups.clear();
    progressViewState.selectedGroups.clear();
    progressViewState.currentGroupIds.clear();
    progressViewState.activeStream = '';
    progressViewDomHandler.taskGroups.clear();
    if (progressViewDomHandler.instructionPanel?.cleanup) {
      progressViewDomHandler.instructionPanel.cleanup();
    }
    global.document = originalDocument;
    (global as any).window = originalWindow;
    (global as any).navigator = originalNavigator;
  });

  it('selects the preferred root group and updates state', () => {
    handler.handleUpdateLogs({
      command: 'updateLogContent',
      stream: 'stream-1',
      messages: [],
      groups: [
        {
          id: 'group-1',
          name: 'First run',
          startTime: 1,
          status: 'running',
        },
        {
          id: 'group-2',
          name: 'Second run',
          startTime: 2,
          status: 'running',
        },
      ],
      taskGroupId: 'group-2',
    } as any);

    assert.equal(progressViewState.getSelectedGroup('stream-1'), 'group-2');
    const selector = global.document?.getElementById(
      'sessionSelector',
    ) as HTMLSelectElement;
    assert.equal(selector?.value, 'group-2');
    const optionLabels = Array.from(selector.options).map(
      (opt) => opt.textContent,
    );
    assert.ok(
      optionLabels.every((label) => label && !label.includes('Run:')),
      'session labels should omit run prefixes',
    );

    selector.value = 'group-1';
    selector.dispatchEvent(new global.window.Event('change'));

    assert.equal(progressViewState.getSelectedGroup('stream-1'), 'group-1');
  });

  it('keeps instructions isolated per stream even with reused group ids', () => {
    handler.handleUpdateLogs({
      command: 'updateLogContent',
      stream: 'stream-1',
      messages: [],
      groups: [
        {
          id: 'group-1',
          name: 'First run',
          startTime: 1,
          status: 'running',
        },
      ],
      taskGroupId: 'group-1',
    } as any);

    handler.handleUpdateInstruction({
      command: 'updateInstruction',
      stream: 'stream-1',
      taskGroupId: 'group-1',
      instruction: { text: 'First instruction' },
    } as any);

    const streamOneGroup = progressViewState.taskGroups.get(
      'stream-1',
      'group-1',
    );
    assert.equal(streamOneGroup?.instruction?.text, 'First instruction');

    progressViewState.activeStream = 'stream-2';
    handler.handleUpdateLogs({
      command: 'updateLogContent',
      stream: 'stream-2',
      messages: [],
      groups: [
        {
          id: 'group-1',
          name: 'Second run',
          startTime: 2,
          status: 'running',
        },
      ],
      taskGroupId: 'group-1',
    } as any);

    handler.handleUpdateInstruction({
      command: 'updateInstruction',
      stream: 'stream-2',
      taskGroupId: 'group-1',
      instruction: { text: 'Second instruction' },
    } as any);

    const streamTwoGroup = progressViewState.taskGroups.get(
      'stream-2',
      'group-1',
    );
    assert.equal(streamTwoGroup?.instruction?.text, 'Second instruction');
    const streamOneGroupAfter = progressViewState.taskGroups.get(
      'stream-1',
      'group-1',
    );
    assert.equal(streamOneGroupAfter?.instruction?.text, 'First instruction');
  });
});

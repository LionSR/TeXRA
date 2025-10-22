// Standard library imports
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

function loadFileListModule(dom: JSDOM) {
  const filePath = path.resolve(
    __dirname,
    '../../webview/modules/uiManagers/FileList.js',
  );
  let code = fs.readFileSync(filePath, 'utf8');

  code = code.replace(/^import .*;$/gm, '');
  code = code.replace('export class FileList', 'class FileList');
  code = code.replace(
    'export const fileList = new FileList();',
    'const fileList = new FileList();\nmodule.exports = { FileList, fileList };',
  );

  const iconCalls: Array<{ elementId: string | null; isVisible: boolean }> = [];

  const context = {
    module: { exports: {} },
    exports: {},
    document: dom.window.document,
    window: dom.window,
    console,
    addEventListenerSafely: (
      el: Element,
      event: string,
      handler: EventListener,
    ) => {
      el.addEventListener(event, handler);
    },
    safeGetElementById: (id: string) => dom.window.document.getElementById(id),
    setChevronIcon: (element: HTMLElement | null, isVisible: boolean) => {
      iconCalls.push({ elementId: element?.id ?? null, isVisible });
    },
    createFromTemplate: (
      _templateId: string,
      config: { text?: Record<string, string>; dataset?: Record<string, any> },
    ) => {
      const item = dom.window.document.createElement('div');
      item.className = 'file-item';
      const pathValue = config.dataset?.['']?.path ?? '';
      item.dataset.path = pathValue;

      const nameSpan = dom.window.document.createElement('span');
      nameSpan.className = 'file-name';
      nameSpan.textContent = config.text?.['.file-name'] ?? pathValue;
      item.appendChild(nameSpan);

      const removeButton = dom.window.document.createElement('button');
      removeButton.className = 'remove-button';
      removeButton.type = 'button';
      removeButton.textContent = 'remove';
      item.appendChild(removeButton);

      return item;
    },
    capitalize: (value: string) =>
      value.charAt(0).toUpperCase() + value.slice(1),
  } as unknown as vm.Context;

  (context as any).globalThis = context;
  (context as any).HTMLElement = dom.window.HTMLElement;
  (context as any).Node = dom.window.Node;
  (context as any).Event = dom.window.Event;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'FileList.js' });

  return {
    FileList: (context.module as any).exports.FileList as any,
    iconCalls,
  };
}

function loadMessageHandlerModule(dom: JSDOM) {
  const filePath = path.resolve(
    __dirname,
    '../../webview/modules/messageHandlers.js',
  );
  let code = fs.readFileSync(filePath, 'utf8');

  const importMap: Record<string, string> = {
    './constants.js': 'constants',
    './eventBus.js': 'eventBus',
    './handlers/fileHandlers.js': 'fileHandlers',
    './handlers/recordingHandlers.js': 'recordingHandlers',
    './handlers/themeHandlers.js': 'themeHandlers',
    './mainViewState.js': 'mainViewState',
    './uiManagers/FileSelect.js': 'fileSelect',
    './uiManagers/BannerManager.js': 'bannerManager',
    './uiManagers/FileList.js': 'fileListModule',
    '@common/domUtils.js': 'domUtils',
    '@common/stringUtils.js': 'stringUtils',
    '@common/webview/commands.js': 'commands',
    '@common/webviewContext.js': 'webviewContext',
    '@common/BaseWebviewMessageHandler.js': 'baseHandler',
  };

  code = code.replace(
    /import\s+{\s*([^}]+)\s*}\s+from\s+'([^']+)';/g,
    (_match, imports, specifier) => {
      const key = importMap[specifier];
      if (!key) {
        throw new Error(`Missing mock for ${specifier}`);
      }
      return `const { ${imports.trim()} } = __mocks.${key};`;
    },
  );

  code = code.replace(
    'export class MainViewMessageHandler',
    'class MainViewMessageHandler',
  );
  code = code.replace(
    /const handler = new MainViewMessageHandler\(\);[\s\S]*?export const cleanup = handler.cleanup.bind\(handler\);/m,
    '',
  );
  code += '\nmodule.exports = { MainViewMessageHandler };';

  const fileListAddCalls: Array<{ listId: string; file: string }> = [];
  const fileListRemoveCallbacks = new Map<string, (files: string[]) => void>();
  const vscodeMessages: any[] = [];
  const mainViewStateSetCalls: any[] = [];
  const mainViewStateUpdateCalls: any[] = [];
  const setChevronCalls: Array<{
    elementId: string | null;
    isVisible: boolean;
  }> = [];
  let restoreCalled = false;

  const constantsMock = {
    FILE_TYPES: ['input', 'reference', 'auxiliary', 'media', 'output'],
    INPUT_FILE: 'inputFile',
    REFERENCE_FILE: 'referenceFile',
    AUXILIARY_FILE: 'auxiliaryFile',
    MEDIA_FILE: 'mediaFile',
    EDITED_FILE: 'editedFile',
    BASE_FILE: 'baseFile',
    ELEMENT_IDS: {
      OUTPUT_FILES: 'outputFiles',
      OUTPUT_FILES_CONTAINER: 'outputFilesContainer',
      TOGGLE_OUTPUT_FILES: 'toggleOutputFiles',
      SESSION_TYPE_TOGGLE: 'sessionTypeToggle',
      LATEXDIFFS_CONTENT: 'latexdiffsContent',
      TOGGLE_LATEXDIFFS: 'toggleLatexdiffs',
      TOGGLE_TOOL_CONFIG: 'toggleToolConfig',
      TOOL_CONFIG_OPTIONS: 'toolConfigOptions',
      TOGGLE_AUTO_EXTRACT: 'toggleAutoExtract',
      AUTO_EXTRACT_OPTIONS: 'autoExtractOptions',
      API_KEY_BANNER: 'apiKeyBanner',
      AGENT_CONFIG_BANNER: 'agentConfigBanner',
    },
    SESSION_TYPES: { WORKFLOW: 'workflow', TOOL_USE: 'toolUse' },
    SESSION_TYPE_INPUT: 'sessionType',
    AGENT_SELECT_IDS: {
      workflow: 'workflowAgentSelect',
      toolUse: 'toolUseAgentSelect',
    },
    AGENT_SELECT_LIST: ['workflowAgentSelect', 'toolUseAgentSelect'],
  };

  const domUtilsMock = {
    safeSetElementValue: (id: string, value: string) => {
      const element = dom.window.document.getElementById(
        id,
      ) as HTMLInputElement | null;
      if (element) {
        (element as any).value = value;
      }
    },
    safeGetElementById: (id: string) => dom.window.document.getElementById(id),
    setChevronIcon: (element: HTMLElement | null, isVisible: boolean) => {
      setChevronCalls.push({ elementId: element?.id ?? null, isVisible });
    },
  };

  const __mocks = {
    constants: constantsMock,
    eventBus: { webviewEventBus: { dispatchEvent: () => {} } },
    fileHandlers: { createFileHandlers: () => ({}) },
    recordingHandlers: { createRecordingHandlers: () => ({}) },
    themeHandlers: { createThemeHandlers: () => ({}) },
    mainViewState: {
      mainViewState: {
        set: (state: any) => {
          mainViewStateSetCalls.push(state);
        },
        restore: () => {
          restoreCalled = true;
        },
        update: (update: any) => {
          mainViewStateUpdateCalls.push(update);
        },
        get: () => ({}),
      },
    },
    fileSelect: {
      fileSelect: {
        update: () => {},
        updateEdited: () => {},
        setAgentDefaultOutputFiles: () => {},
        handleRecentCommits: () => {},
        handleSetCurrentFile: () => {},
        handleSetSelectedCommit: () => {},
      },
    },
    bannerManager: {
      bannerManager: {
        showBanner: () => {},
        hideBanner: () => {},
      },
    },
    fileListModule: {
      fileList: {
        add: (listId: string, file: string) => {
          fileListAddCalls.push({ listId, file });
        },
        setRemoveCallback: (
          listId: string,
          callback: (files: string[]) => void,
        ) => {
          fileListRemoveCallbacks.set(listId, callback);
        },
      },
    },
    domUtils: domUtilsMock,
    stringUtils: {
      capitalize: (value: string) =>
        value.charAt(0).toUpperCase() + value.slice(1),
      uncapitalize: (value: string) =>
        value.charAt(0).toLowerCase() + value.slice(1),
    },
    commands: {
      MAIN_VIEW_COMMANDS: {
        UPDATE_INPUT_FILES: 'updateInputFiles',
        UPDATE_REFERENCE_FILES: 'updateReferenceFiles',
        UPDATE_AUXILIARY_FILES: 'updateAuxiliaryFiles',
        UPDATE_MEDIA_FILES: 'updateMediaFiles',
        UPDATE_OUTPUT_FILES: 'updateOutputFiles',
        SHOW_API_KEY_BANNER: 'showApiKeyBanner',
        HIDE_API_KEY_BANNER: 'hideApiKeyBanner',
        SHOW_AGENT_CONFIG_BANNER: 'showAgentConfigBanner',
        HIDE_AGENT_CONFIG_BANNER: 'hideAgentConfigBanner',
        SHOW_DEPENDENCY_BANNER: 'showDependencyBanner',
        HIDE_DEPENDENCY_BANNER: 'hideDependencyBanner',
        SET_MODEL_OPTIONS: 'setModelOptions',
        SET_AGENT_OPTIONS: 'setAgentOptions',
        SHOW_INFORMATION_MESSAGE: 'showInformationMessage',
        REQUEST_DEFAULT_OUTPUT_FILES: 'requestDefaultOutputFiles',
        STATE_RESTORE: 'stateRestore',
        CHECK_RESTORED_BASE_FILE: 'checkRestoredBaseFile',
      },
    },
    webviewContext: {
      vscode: {
        postMessage: (message: any) => {
          vscodeMessages.push(message);
        },
      },
    },
    baseHandler: {
      BaseWebviewMessageHandler: class {
        setup() {}
        cleanup() {}
      },
    },
  };

  const context = {
    __mocks,
    module: { exports: {} },
    exports: {},
    document: dom.window.document,
    window: dom.window,
    console,
  } as unknown as vm.Context;

  (context as any).globalThis = context;
  (context as any).HTMLElement = dom.window.HTMLElement;
  (context as any).HTMLSelectElement = dom.window.HTMLSelectElement;
  (context as any).Event = dom.window.Event;
  (context as any).CustomEvent = dom.window.CustomEvent;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'messageHandlers.js' });

  return {
    MainViewMessageHandler: (context.module as any).exports
      .MainViewMessageHandler as any,
    mocks: {
      fileListAddCalls,
      fileListRemoveCallbacks,
      vscodeMessages,
      mainViewStateSetCalls,
      mainViewStateUpdateCalls,
      setChevronCalls,
      restoreCalled: () => restoreCalled,
      constants: constantsMock,
    },
  };
}

describe('FileList remove callbacks', () => {
  it('invokes registered callbacks and hides the container when empty', () => {
    const dom = new JSDOM(`
      <div id="inputFilesContainer" style="display: block;">
        <div id="inputFiles"></div>
      </div>
      <div id="toggleInputFiles"></div>
    `);

    const { FileList, iconCalls } = loadFileListModule(dom);
    let saveCount = 0;
    let lastRemoved: string[] | null = null;
    const list = new FileList(() => {
      saveCount += 1;
    });
    list.setRemoveCallback('inputFiles', (files: string[]) => {
      lastRemoved = files;
    });

    list.add('inputFiles', 'alpha.tex');
    list.add('inputFiles', 'beta.tex');

    const firstRemove = dom.window.document.querySelector(
      '#inputFiles .remove-button',
    ) as HTMLElement;
    firstRemove.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.deepEqual(lastRemoved, ['beta.tex']);
    assert.strictEqual(saveCount, 1);

    const secondRemove = dom.window.document.querySelector(
      '#inputFiles .remove-button',
    ) as HTMLElement;
    secondRemove.dispatchEvent(
      new dom.window.Event('click', { bubbles: true }),
    );
    assert.deepEqual(lastRemoved, []);
    assert.strictEqual(
      dom.window.document.getElementById('inputFilesContainer')?.style.display,
      'none',
    );
    assert(
      iconCalls.some(
        (call) =>
          call.elementId === 'toggleInputFiles' && call.isVisible === false,
      ),
      'expected toggle icon to be updated when the list becomes empty',
    );
    assert.strictEqual(saveCount, 3);
  });
});

describe('MainViewMessageHandler state restoration', () => {
  it('hydrates lists through FileList and wires removal callbacks', () => {
    const dom = new JSDOM(`
      <input id="sessionType" />
      <vscode-single-select id="workflowAgentSelect"></vscode-single-select>
      <vscode-single-select id="toolUseAgentSelect"></vscode-single-select>
      <vscode-single-select id="model"></vscode-single-select>
      <vscode-textarea id="instruction"></vscode-textarea>
      <vscode-single-select id="inputFile"></vscode-single-select>
      <vscode-single-select id="referenceFile"></vscode-single-select>
      <vscode-single-select id="auxiliaryFile"></vscode-single-select>
      <vscode-single-select id="mediaFile"></vscode-single-select>
      <div id="sessionTypeToggle">
        <button data-session-type="workflow"></button>
        <button data-session-type="toolUse"></button>
      </div>
      <div id="inputFilesContainer" style="display: none;">
        <div id="inputFiles"></div>
      </div>
      <div id="toggleInputFiles"></div>
    `);

    const { MainViewMessageHandler, mocks } = loadMessageHandlerModule(dom);
    const handler = new MainViewMessageHandler();

    handler._handleStateRestoration({
      agentConfig: {
        sessionType: 'workflow',
        workflowAgent: 'agent-a',
        inputFiles: ['alpha.tex', 'beta.tex'],
        inputFilesActive: true,
      },
      activeFiles: { input: true },
    });

    assert.deepEqual(mocks.fileListAddCalls, [
      { listId: 'inputFiles', file: 'alpha.tex' },
      { listId: 'inputFiles', file: 'beta.tex' },
    ]);

    assert.strictEqual(mocks.mainViewStateSetCalls.length, 1);
    assert.deepEqual(mocks.mainViewStateSetCalls[0].inputFiles, [
      'alpha.tex',
      'beta.tex',
    ]);
    assert.strictEqual(mocks.mainViewStateSetCalls[0].inputFilesActive, true);
    assert.strictEqual(mocks.restoreCalled(), true);

    const container = dom.window.document.getElementById('inputFilesContainer');
    assert.strictEqual(container?.style.display, 'block');
    assert(
      mocks.setChevronCalls.some(
        (call) =>
          call.elementId === 'toggleInputFiles' && call.isVisible === true,
      ),
      'expected toggle icon to be expanded when restoring visible list',
    );

    const removeCallback = mocks.fileListRemoveCallbacks.get('inputFiles');
    assert(removeCallback, 'expected removal callback to be registered');
    removeCallback!(['beta.tex']);
    assert.deepEqual(mocks.vscodeMessages.pop(), {
      command: 'updateInputFiles',
      files: ['beta.tex'],
    });
    assert.deepEqual(mocks.mainViewStateUpdateCalls.pop(), {
      inputFiles: ['beta.tex'],
    });
  });
});

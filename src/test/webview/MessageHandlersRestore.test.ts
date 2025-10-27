// Standard library imports
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// Third-party imports
// @ts-ignore: jsdom lacks ESM typings in this context
import { JSDOM } from 'jsdom';

function registerVSCodeComponents(dom: JSDOM) {
  const { customElements } = dom.window;
  const HTMLElementCtor = dom.window
    .HTMLElement as unknown as typeof HTMLElement;
  if (!customElements) {
    return;
  }

  if (!customElements.get('vscode-option')) {
    class VSCodeOptionElement extends HTMLElementCtor {
      get value(): string {
        const attr = this.getAttribute('value');
        return attr ?? this.textContent ?? '';
      }

      set value(nextValue: string | null | undefined) {
        if (nextValue === null || nextValue === undefined) {
          this.removeAttribute('value');
          return;
        }
        this.setAttribute('value', nextValue);
      }

      get selected(): boolean {
        return this.hasAttribute('selected');
      }

      set selected(isSelected: boolean) {
        if (isSelected) {
          this.setAttribute('selected', '');
          this.setAttribute('aria-selected', 'true');
        } else {
          this.removeAttribute('selected');
          this.removeAttribute('aria-selected');
        }
      }
    }

    customElements.define('vscode-option', VSCodeOptionElement);
  }

  if (!customElements.get('vscode-single-select')) {
    class VSCodeSingleSelectElement extends HTMLElementCtor {
      private _value = '';
      private _selectedIndex = -1;

      static get observedAttributes() {
        return ['value'];
      }

      connectedCallback(): void {
        this.#upgradeProperty('value');
        if (!this.hasAttribute('role')) {
          this.setAttribute('role', 'combobox');
        }

        if (this.hasAttribute('value')) {
          this.#applyValue(this.getAttribute('value') ?? '');
        } else {
          const selectedOption = this.options.find((option) => option.selected);
          if (selectedOption) {
            this.#applyValue(selectedOption.value);
          }
        }
      }

      attributeChangedCallback(
        _name: string,
        _oldValue: string | null,
        newValue: string | null,
      ) {
        this.#applyValue(newValue ?? '');
      }

      get value(): string {
        return this._value;
      }

      set value(nextValue: string | null | undefined) {
        const normalized = nextValue ?? '';
        if (normalized === this._value) {
          return;
        }
        this.#applyValue(normalized);
        if (this.getAttribute('value') !== normalized) {
          this.setAttribute('value', normalized);
        }
      }

      get options(): Array<HTMLElement & { value: string; selected: boolean }> {
        return Array.from(this.querySelectorAll('vscode-option')) as Array<
          HTMLElement & { value: string; selected: boolean }
        >;
      }

      get selectedIndex(): number {
        if (this._selectedIndex >= 0) {
          return this._selectedIndex;
        }
        return this.options.findIndex((option) => option.selected);
      }

      set selectedIndex(index: number) {
        const options = this.options;
        if (index < 0 || index >= options.length) {
          this._selectedIndex = -1;
          this._value = '';
          this.removeAttribute('value');
          options.forEach((option) => {
            option.selected = false;
          });
          return;
        }

        options.forEach((option, optionIndex) => {
          option.selected = optionIndex === index;
        });

        const selectedOption = options[index];
        this._selectedIndex = index;
        this._value = selectedOption?.value ?? '';
        if (selectedOption) {
          this.setAttribute('value', selectedOption.value);
        } else {
          this.removeAttribute('value');
        }
      }

      #applyValue(value: string) {
        this._value = value ?? '';
        const options = this.options;
        let matched = false;
        options.forEach((option, index) => {
          const isMatch = option.value === this._value;
          option.selected = isMatch;
          if (isMatch) {
            matched = true;
            this._selectedIndex = index;
          }
        });
        if (!matched) {
          this._selectedIndex = -1;
        }
      }

      #upgradeProperty(prop: string) {
        if (Object.prototype.hasOwnProperty.call(this, prop)) {
          const value = (this as unknown as Record<string, unknown>)[prop];
          delete (this as unknown as Record<string, unknown>)[prop];
          (this as unknown as Record<string, unknown>)[prop] = value;
        }
      }
    }

    customElements.define('vscode-single-select', VSCodeSingleSelectElement);
  }
}

function createTestDom(markup: string): JSDOM {
  const dom = new JSDOM(markup);
  registerVSCodeComponents(dom);
  return dom;
}

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
  } as unknown as vm.Context;

  (context as any).globalThis = context;
  (context as any).HTMLElement = dom.window.HTMLElement;
  (context as any).Node = dom.window.Node;
  (context as any).Event = dom.window.Event;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'FileList.js' });

  return {
    FileList: (context.module as any).exports.FileList as any,
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
      restoreCalled: () => restoreCalled,
      constants: constantsMock,
    },
  };
}

describe('FileList remove callbacks', () => {
  it('invokes registered callbacks and hides the container when empty', () => {
    const dom = createTestDom(`
      <vscode-collapsible id="inputFilesContainer" open>
        <div id="inputFiles"></div>
      </vscode-collapsible>
    `);

    const { FileList } = loadFileListModule(dom);
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

    const container = dom.window.document.getElementById('inputFilesContainer');
    let toggleCount = 0;
    container?.addEventListener('toggle', () => {
      toggleCount += 1;
    });

    const secondRemove = dom.window.document.querySelector(
      '#inputFiles .remove-button',
    ) as HTMLElement;
    secondRemove.dispatchEvent(
      new dom.window.Event('click', { bubbles: true }),
    );
    assert.deepEqual(lastRemoved, []);
    assert.strictEqual(container?.hasAttribute('open'), false);
    assert.strictEqual(toggleCount > 0, true);
    assert.strictEqual(saveCount, 3);
  });
});

describe('MainViewMessageHandler state restoration', () => {
  it('hydrates lists through FileList and wires removal callbacks', () => {
    const dom = createTestDom(`
      <vscode-single-select id="sessionType" value="workflow">
        <vscode-option value="workflow">Workflow</vscode-option>
        <vscode-option value="toolUse">Tool Use</vscode-option>
      </vscode-single-select>
      <vscode-single-select id="workflowAgentSelect">
        <vscode-option value="agent-a">Agent A</vscode-option>
        <vscode-option value="agent-b">Agent B</vscode-option>
      </vscode-single-select>
      <vscode-single-select id="toolUseAgentSelect">
        <vscode-option value="agent-a">Agent A</vscode-option>
        <vscode-option value="agent-b">Agent B</vscode-option>
      </vscode-single-select>
      <input id="model" />
      <textarea id="instruction"></textarea>
      <input id="inputFile" />
      <input id="referenceFile" />
      <input id="auxiliaryFile" />
      <input id="mediaFile" />
      <vscode-radio-group id="sessionTypeToggle">
        <vscode-radio data-session-type="workflow" value="workflow"></vscode-radio>
        <vscode-radio data-session-type="toolUse" value="toolUse"></vscode-radio>
      </vscode-radio-group>
      <vscode-collapsible id="inputFilesContainer">
        <div id="inputFiles"></div>
      </vscode-collapsible>
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
    assert.strictEqual(container?.hasAttribute('open'), true);

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

// Local imports
import { vscode } from '@common/webviewContext.js';
import { safeGetElementById } from '@common/domUtils.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES,
} from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import { mainViewState } from '../mainViewState.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { ELEMENT_IDS } from '../constants.js';

export class SettingsButtonManager {
  constructor(
    vscodeInstance = vscode,
    toggleManager,
    latexdiffManager,
    state = mainViewState,
  ) {
    this.vscode = vscodeInstance;
    this.toggleManager = toggleManager;
    this.latexdiffManager = latexdiffManager;
    this.state = state;
    this._listeners = [];
  }

  _addListener(elementOrId, event, handler) {
    const element =
      typeof elementOrId === 'string'
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler);
      this._listeners.push({ element, event, handler });
    }
  }

  _setupToggles() {
    this._addListener(ELEMENT_IDS.TOGGLE_AUTO_EXTRACT, 'click', (e) => {
      e.stopPropagation();
      const options = safeGetElementById(ELEMENT_IDS.AUTO_EXTRACT_OPTIONS);
      if (options) {
        const visible = options.style.display === 'block';
        options.style.display = visible ? 'none' : 'block';
      }
      this.toggleManager.updateAutoToggleState();
    });

    this._addListener(ELEMENT_IDS.TOGGLE_TOOL_CONFIG, 'click', (e) => {
      e.stopPropagation();
      const options = safeGetElementById(ELEMENT_IDS.TOOL_CONFIG_OPTIONS);
      if (options) {
        const visible = options.style.display === 'block';
        options.style.display = visible ? 'none' : 'block';
      }
      this.toggleManager.updateToolConfigToggleState();
    });

    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      this._addListener(id, 'change', () => {
        this.toggleManager.updateAutoToggleState();
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      this._addListener(id, 'change', () => {
        this.toggleManager.updateToolConfigToggleState();
      });
    });

    CHECK_BOXES.forEach((id) => {
      this._addListener(id, 'change', handleCheckboxChange);
    });

    this._addListener(ELEMENT_IDS.TOGGLE_LATEXDIFFS, 'click', () => {
      this.latexdiffManager.toggleLatexdiffs();
    });
  }

  _setupSettingsButtons() {
    this._addListener(ELEMENT_IDS.AGENT_SETTINGS_BUTTON, 'click', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      });
    });

    this._addListener(ELEMENT_IDS.MODEL_SETTINGS_BUTTON, 'click', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS,
      });
    });
  }

  _setupDropdowns() {
    this._addListener('agent', 'change', (e) => {
      const selectedAgent = e.target.value;
      const reflectCheckbox = safeGetElementById('reflect');
      if (reflectCheckbox) {
        reflectCheckbox.checked = !selectedAgent.startsWith('correct');
      }
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
      });
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES,
        agent: selectedAgent,
      });
      this.state.save();
    });

    this._addListener('model', 'change', (e) => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
        model: e.target.value,
      });
      this.state.save();
    });
  }

  setup() {
    this._setupToggles();
    this._setupSettingsButtons();
    this._setupDropdowns();
  }

  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];
  }
}

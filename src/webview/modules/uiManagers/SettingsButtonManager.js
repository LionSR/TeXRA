// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
} from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import { webviewState } from '../webviewState.js';

export class SettingsButtonManager {
  constructor(
    vscodeInstance = vscode,
    toggleManager,
    latexdiffManager,
    state = webviewState,
  ) {
    this.vscode = vscodeInstance;
    this.toggleManager = toggleManager;
    this.latexdiffManager = latexdiffManager;
    this.state = state;
    this._listeners = [];
  }

  _addListener(elementOrId, event, handler) {
    addEventListenerSafely(elementOrId, event, handler);
    const element =
      typeof elementOrId === 'string'
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      this._listeners.push({ element, event, handler });
    }
  }

  _setupToggles() {
    const settingsBtnMgr = this;
    this._addListener('toggleAutoExtract', 'click', (e) => {
      e.stopPropagation();
      const options = document.getElementById('autoExtractOptions');
      const visible = options.style.display === 'block';
      options.style.display = visible ? 'none' : 'block';
      this.toggleManager.updateAutoToggleState();
    });

    this._addListener('toggleToolConfig', 'click', (e) => {
      e.stopPropagation();
      const options = document.getElementById('toolConfigOptions');
      const visible = options.style.display === 'block';
      options.style.display = visible ? 'none' : 'block';
      this.toggleManager.updateToolConfigToggleState();
    });

    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      this._addListener(id, 'change', function () {
        settingsBtnMgr.toggleManager.updateAutoToggleState();
        handleCheckboxChange.call(this);
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      this._addListener(id, 'change', function () {
        settingsBtnMgr.toggleManager.updateToolConfigToggleState();
        handleCheckboxChange.call(this);
      });
    });

    this._addListener('toggleLatexdiffs', 'click', () => {
      this.latexdiffManager.toggleLatexdiffs();
    });
  }

  _setupSettingsButtons() {
    this._addListener('agentSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openAgentSettings' });
    });

    this._addListener('modelSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openModelSettings' });
    });
  }

  _setupDropdowns() {
    this._addListener('agent', 'change', (e) => {
      const selectedAgent = e.target.value;
      const reflectCheckbox = document.getElementById('reflect');
      if (reflectCheckbox) {
        reflectCheckbox.checked = !selectedAgent.startsWith('correct');
      }
      this.vscode.postMessage({ command: 'requestMediaFile' });
      this.vscode.postMessage({
        command: 'requestDefaultOutputFiles',
        agent: selectedAgent,
      });
      this.state.save();
    });

    this._addListener('model', 'change', (e) => {
      this.vscode.postMessage({
        command: 'modelSelected',
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

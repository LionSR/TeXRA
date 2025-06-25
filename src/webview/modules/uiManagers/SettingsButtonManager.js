// Local imports
import { vscode } from '@common/webviewContext.js';
import { addEventListenerSafely } from '@common/domUtils.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
} from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';

export class SettingsButtonManager {
  constructor(vscodeInstance = vscode, toggleManager, latexdiffManager) {
    this.vscode = vscodeInstance;
    this.toggleManager = toggleManager;
    this.latexdiffManager = latexdiffManager;
  }

  _setupToggles() {
    const settingsBtnMgr = this;
    addEventListenerSafely('toggleAutoExtract', 'click', (e) => {
      e.stopPropagation();
      const options = document.getElementById('autoExtractOptions');
      const visible = options.style.display === 'block';
      options.style.display = visible ? 'none' : 'block';
      this.toggleManager.updateAutoToggleState();
    });

    addEventListenerSafely('toggleToolConfig', 'click', (e) => {
      e.stopPropagation();
      const options = document.getElementById('toolConfigOptions');
      const visible = options.style.display === 'block';
      options.style.display = visible ? 'none' : 'block';
      this.toggleManager.updateToolConfigToggleState();
    });

    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      addEventListenerSafely(id, 'change', function () {
        settingsBtnMgr.toggleManager.updateAutoToggleState();
        handleCheckboxChange.call(this);
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      addEventListenerSafely(id, 'change', function () {
        settingsBtnMgr.toggleManager.updateToolConfigToggleState();
        handleCheckboxChange.call(this);
      });
    });

    addEventListenerSafely('toggleLatexdiffs', 'click', () => {
      this.latexdiffManager.toggleLatexdiffs();
    });
  }

  _setupSettingsButtons() {
    addEventListenerSafely('agentSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openAgentSettings' });
    });

    addEventListenerSafely('modelSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openModelSettings' });
    });
  }

  _setupDropdowns() {
    addEventListenerSafely('agent', 'change', function () {
      const selectedAgent = this.value;
      const reflectCheckbox = document.getElementById('reflect');
      if (reflectCheckbox) {
        reflectCheckbox.checked = !selectedAgent.startsWith('correct');
      }

      vscode.postMessage({ command: 'requestMediaFile' });
      vscode.postMessage({
        command: 'requestDefaultOutputFiles',
        agent: selectedAgent,
      });
    });

    addEventListenerSafely('model', 'change', function () {
      vscode.postMessage({
        command: 'modelSelected',
        model: this.value,
      });
    });
  }

  setup() {
    this._setupToggles();
    this._setupSettingsButtons();
    this._setupDropdowns();
  }
}

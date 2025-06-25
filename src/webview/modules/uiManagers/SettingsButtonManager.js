// Local imports
import { vscode } from '@common/webviewContext.js';
import { addEventListenerSafely } from '@common/domUtils.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
} from '../constants.js';
import { latexdiffManager } from './LatexdiffManager.js';

/**
 * Handles settings toggles and section visibility.
 */
export class SettingsButtonManager {
  constructor(vscodeApi = vscode, toggleMgr, latexdiffMgr = latexdiffManager) {
    this.vscode = vscodeApi;
    this.toggleManager = toggleMgr;
    this.latexdiffManager = latexdiffMgr;
  }

  setup() {
    this._setupDropdownToggles();
    this._setupCheckboxHandlers();
    this._setupSettingsButtons();
    this._setupLatexdiffToggle();
    this._setupAgentModelChange();
  }

  _setupDropdownToggles() {
    addEventListenerSafely('toggleAutoExtract', 'click', (e) => {
      e.stopPropagation();
      const options = document.getElementById('autoExtractOptions');
      const isVisible = options && options.style.display === 'block';
      if (options) options.style.display = isVisible ? 'none' : 'block';
      this.toggleManager.updateAutoToggleState();
    });

    addEventListenerSafely('toggleToolConfig', 'click', (e) => {
      e.stopPropagation();
      const options = document.getElementById('toolConfigOptions');
      const isVisible = options && options.style.display === 'block';
      if (options) options.style.display = isVisible ? 'none' : 'block';
      this.toggleManager.updateToolConfigToggleState();
    });
  }

  _setupCheckboxHandlers() {
    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      addEventListenerSafely(
        id,
        'change',
        function () {
          this.toggleManager.updateAutoToggleState();
          handleCheckboxChange.call(this);
        }.bind(this),
      );
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      addEventListenerSafely(
        id,
        'change',
        function () {
          this.toggleManager.updateToolConfigToggleState();
          handleCheckboxChange.call(this);
        }.bind(this),
      );
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

  _setupLatexdiffToggle() {
    addEventListenerSafely('toggleLatexdiffs', 'click', () => {
      this.latexdiffManager.toggleLatexdiffs();
    });
  }

  _setupAgentModelChange() {
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
      vscode.postMessage({ command: 'modelSelected', model: this.value });
    });
  }
}

export const settingsButtonManager = new SettingsButtonManager();

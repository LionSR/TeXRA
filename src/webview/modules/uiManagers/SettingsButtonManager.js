// Local imports - components
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeGetElementChecked,
} from '@common/domUtils.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES,
} from '../constants.js';
import { handleCheckboxChange, toggleLatexdiffs } from '../fileHandlers.js';
import { ToggleManager } from './ToggleManager.js';

export class SettingsButtonManager {
  constructor(vscodeApi = vscode, toggleMgr = new ToggleManager()) {
    this.vscode = vscodeApi;
    this.toggleManager = toggleMgr;
  }

  setupDropdownToggles() {
    addEventListenerSafely('toggleAutoExtract', 'click', (e) => {
      e.stopPropagation();
      const autoExtractOptions = safeGetElementById('autoExtractOptions');
      const isVisible = autoExtractOptions.style.display === 'block';
      autoExtractOptions.style.display = isVisible ? 'none' : 'block';
      this.toggleManager.updateAutoToggleState();
    });

    addEventListenerSafely('toggleToolConfig', 'click', (e) => {
      e.stopPropagation();
      const toolConfigOptions = safeGetElementById('toolConfigOptions');
      const isVisible = toolConfigOptions.style.display === 'block';
      toolConfigOptions.style.display = isVisible ? 'none' : 'block';
      this.toggleManager.updateToolConfigToggleState();
    });
  }

  setupCheckboxHandlers() {
    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      addEventListenerSafely(
        id,
        'change',
        function () {
          handleCheckboxChange.call(this);
          this.toggleManager?.updateAutoToggleState();
        }.bind(this),
      );
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      addEventListenerSafely(
        id,
        'change',
        function () {
          handleCheckboxChange.call(this);
          this.toggleManager?.updateToolConfigToggleState();
        }.bind(this),
      );
    });

    CHECK_BOXES.forEach((id) => {
      addEventListenerSafely(id, 'change', handleCheckboxChange);
    });
  }

  setupLatexdiffToggle() {
    addEventListenerSafely('toggleLatexdiffs', 'click', () => {
      toggleLatexdiffs();
    });
  }

  setupSettingsButtons() {
    addEventListenerSafely('agentSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openAgentSettings' });
    });

    addEventListenerSafely('modelSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openModelSettings' });
    });
  }

  setupAgentModelSelectors() {
    addEventListenerSafely('agent', 'change', function () {
      const selectedAgent = this.value;
      const reflectCheckbox = safeGetElementById('reflect');
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

  setup() {
    this.setupDropdownToggles();
    this.setupCheckboxHandlers();
    this.setupLatexdiffToggle();
    this.setupSettingsButtons();
    this.setupAgentModelSelectors();
  }
}

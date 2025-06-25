import { vscode as globalVscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
} from '../constants.js';
import { handleCheckboxChange, toggleLatexdiffs } from '../fileHandlers.js';

export class SettingsButtonManager {
  constructor(toggleManager, vscode = globalVscode, state) {
    this.toggleManager = toggleManager;
    this.vscode = vscode;
    this.state = state;
  }

  setup() {
    this.setupToggles();
    this.setupAgentModelSelectors();
    this.setupCheckboxes();
    this.setupSettingsButtons();
    this.setupLatexdiffToggle();
  }

  setupToggles() {
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

  setupAgentModelSelectors() {
    addEventListenerSafely('agent', 'change', (e) => {
      const selectedAgent = e.target.value;
      const reflectCheckbox = safeGetElementById('reflect');
      if (reflectCheckbox) {
        reflectCheckbox.checked = !selectedAgent.startsWith('correct');
      }

      this.vscode.postMessage({ command: 'requestMediaFile' });
      this.vscode.postMessage({
        command: 'requestDefaultOutputFiles',
        agent: selectedAgent,
      });
      if (this.state) {
        this.state.save();
      }
    });

    addEventListenerSafely('model', 'change', (e) => {
      this.vscode.postMessage({
        command: 'modelSelected',
        model: e.target.value,
      });
      if (this.state) {
        this.state.save();
      }
    });
  }

  setupCheckboxes() {
    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      addEventListenerSafely(id, 'change', (e) => {
        this.toggleManager.updateAutoToggleState();
        handleCheckboxChange(e);
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      addEventListenerSafely(id, 'change', (e) => {
        this.toggleManager.updateToolConfigToggleState();
        handleCheckboxChange(e);
      });
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

  setupLatexdiffToggle() {
    addEventListenerSafely('toggleLatexdiffs', 'click', () => {
      toggleLatexdiffs();
    });
  }
}

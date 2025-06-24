import { vscode } from '@common/webviewContext.js';
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
  constructor(toggleManager) {
    this.toggleManager = toggleManager;
  }

  setup() {
    this.setupToggles();
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

  setupCheckboxes() {
    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      addEventListenerSafely(id, 'change', () => {
        this.toggleManager.updateAutoToggleState();
        handleCheckboxChange.call(null, { target: safeGetElementById(id) });
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      addEventListenerSafely(id, 'change', () => {
        this.toggleManager.updateToolConfigToggleState();
        handleCheckboxChange.call(null, { target: safeGetElementById(id) });
      });
    });
  }

  setupSettingsButtons() {
    addEventListenerSafely('agentSettingsButton', 'click', () => {
      vscode.postMessage({ command: 'openAgentSettings' });
    });

    addEventListenerSafely('modelSettingsButton', 'click', () => {
      vscode.postMessage({ command: 'openModelSettings' });
    });
  }

  setupLatexdiffToggle() {
    addEventListenerSafely('toggleLatexdiffs', 'click', () => {
      toggleLatexdiffs();
    });
  }
}

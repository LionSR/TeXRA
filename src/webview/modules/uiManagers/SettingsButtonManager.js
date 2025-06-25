// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  MULTIPLE_SELECTIONS,
} from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import { toggleManager } from './ToggleManager.js';
import { outputFilesManager } from './OutputFilesManager.js';
import { latexdiffManager } from './LatexdiffManager.js';
import { fileList } from './FileList.js';

/**
 * Handles settings and section toggles.
 */
export class SettingsButtonManager {
  constructor(vscodeApi = vscode) {
    this.vscode = vscodeApi;
    this.debugMode = false;
  }

  updateDebugButtonVisibility() {
    const packBtn = safeGetElementById('packButton');
    const cleanBtn = safeGetElementById('cleanButton');
    [packBtn, cleanBtn].forEach((btn) => {
      if (btn) {
        btn.style.display = this.debugMode ? '' : 'none';
      }
    });
  }

  setDebugMode(enabled) {
    this.debugMode = !!enabled;
    this.updateDebugButtonVisibility();
  }

  /** Setup option dropdown toggles and checkbox listeners */
  setupOptionToggles() {
    addEventListenerSafely('toggleAutoExtract', 'click', (e) => {
      e.stopPropagation();
      const autoExtractOptions = safeGetElementById('autoExtractOptions');
      const isVisible = autoExtractOptions.style.display === 'block';
      autoExtractOptions.style.display = isVisible ? 'none' : 'block';
      toggleManager.updateAutoToggleState();
    });

    addEventListenerSafely('toggleToolConfig', 'click', (e) => {
      e.stopPropagation();
      const toolConfigOptions = safeGetElementById('toolConfigOptions');
      const isVisible = toolConfigOptions.style.display === 'block';
      toolConfigOptions.style.display = isVisible ? 'none' : 'block';
      toggleManager.updateToolConfigToggleState();
    });

    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      addEventListenerSafely(id, 'change', function () {
        toggleManager.updateAutoToggleState();
        handleCheckboxChange.call(this);
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      addEventListenerSafely(id, 'change', function () {
        toggleManager.updateToolConfigToggleState();
        handleCheckboxChange.call(this);
      });
    });
  }

  /** Setup toggles for multi-file lists and LaTeX diffs */
  setupSectionToggles() {
    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      addEventListenerSafely(toggleId, 'click', () => {
        if (id === 'outputFiles') {
          outputFilesManager.toggleOutputFiles();
        } else {
          fileList.toggle(id, toggleId);
        }
      });
    });

    addEventListenerSafely('toggleLatexdiffs', 'click', () => {
      latexdiffManager.toggleLatexdiffs();
    });
  }

  /** Setup buttons that open settings */
  setupSettingsButtons() {
    addEventListenerSafely('agentSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openAgentSettings' });
    });
    addEventListenerSafely('modelSettingsButton', 'click', () => {
      this.vscode.postMessage({ command: 'openModelSettings' });
    });
  }

  setup() {
    this.updateDebugButtonVisibility();
    this.setupOptionToggles();
    this.setupSectionToggles();
    this.setupSettingsButtons();
  }
}

export const settingsButtonManager = new SettingsButtonManager();

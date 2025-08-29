// Local imports - webview
import { ELEMENT_IDS } from './constants.js';
import { webviewEventBus } from './eventBus.js';
import { mainViewState } from './mainViewState.js';
import { ActionButtonManager } from './uiManagers/ActionButtonManager.js';
import { FileInputManager } from './uiManagers/FileInputManager.js';
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';
import { InstructionManager } from './uiManagers/InstructionManager.js';
import { latexdiffManager } from './uiManagers/LatexdiffManager.js';
import { outputFilesManager } from './uiManagers/OutputFilesManager.js';
import { RecordingManager } from './uiManagers/RecordingManager.js';
import { SettingsButtonManager } from './uiManagers/SettingsButtonManager.js';
import { ToggleManager } from './uiManagers/ToggleManager.js';
import { vscode } from '@common/webviewContext.js';
import { ApiKeyBannerManager } from './uiManagers/ApiKeyBannerManager.js';

export const instructionManager = new InstructionManager(
  'instruction',
  vscode,
  mainViewState,
);
export const toggleManager = new ToggleManager();
export const recordingManager = new RecordingManager(vscode, webviewEventBus);
export const apiKeyBannerManager = new ApiKeyBannerManager(vscode);

/**
 * Coordinates UI managers for the main webview.
 */
export class MainViewDomHandler {
  constructor() {
    this.fileInputManager = null;
    this.actionButtonManager = null;
    this.settingsButtonManager = null;
    this.apiKeyBannerManager = null;
    this.debugMode = false;
  }

  _updateDebugButtonVisibility() {
    const packBtn = document.getElementById(ELEMENT_IDS.PACK_BUTTON);
    const cleanBtn = document.getElementById(ELEMENT_IDS.CLEAN_BUTTON);
    [packBtn, cleanBtn].forEach((btn) => {
      if (btn) {
        btn.style.display = this.debugMode ? '' : 'none';
      }
    });
  }

  setDebugMode(enabled) {
    this.debugMode = !!enabled;
    this._updateDebugButtonVisibility();
  }

  initializeUI() {
    this._updateDebugButtonVisibility();

    this.fileInputManager = new FileInputManager(
      vscode,
      mainViewState,
      fileList,
      fileSelect,
      outputFilesManager,
    );
    this.actionButtonManager = new ActionButtonManager(
      vscode,
      fileList,
      mainViewState,
      instructionManager,
    );
    this.settingsButtonManager = new SettingsButtonManager(
      vscode,
      toggleManager,
      latexdiffManager,
      mainViewState,
    );
    this.apiKeyBannerManager = apiKeyBannerManager;

    this.fileInputManager.setup();
    this.actionButtonManager.setup();
    this.settingsButtonManager.setup();
    recordingManager.setupRecordButton();
    this.apiKeyBannerManager.setup();
  }

  cleanupUI() {
    if (this.fileInputManager) {
      this.fileInputManager.cleanup();
      this.fileInputManager = null;
    }
    if (this.actionButtonManager) {
      this.actionButtonManager.cleanup();
      this.actionButtonManager = null;
    }
    if (this.settingsButtonManager) {
      this.settingsButtonManager.cleanup();
      this.settingsButtonManager = null;
    }
    if (this.apiKeyBannerManager) {
      this.apiKeyBannerManager.cleanup();
      this.apiKeyBannerManager = null;
    }
  }
}

export const mainViewDomHandler = new MainViewDomHandler();

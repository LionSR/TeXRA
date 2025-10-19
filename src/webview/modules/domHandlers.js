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
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';

export const instructionManager = new InstructionManager(
  'instruction',
  vscode,
  mainViewState,
);
export const toggleManager = new ToggleManager();
export const recordingManager = new RecordingManager(vscode);

/**
 * Coordinates UI managers for the main webview.
 */
class MainViewDomHandler extends BaseDomHandler {
  constructor() {
    super();
    this.fileInputManager = null;
    this.actionButtonManager = null;
    this.settingsButtonManager = null;
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
      webviewEventBus,
    );

    this.fileInputManager.setup();
    this.actionButtonManager.setup();
    this.settingsButtonManager.setup();
    recordingManager.setupRecordButton();

    this.addListener(ELEMENT_IDS.API_KEY_BANNER_BUTTON, 'click', () => {
      // Get provider from banner element to determine which setup to open
      const banner = document.getElementById(ELEMENT_IDS.API_KEY_BANNER);
      const provider = banner?.dataset?.provider;

      if (provider) {
        // Provider-specific context - use provider-specific API key setup
        vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY,
          provider,
        });
      } else {
        // General context - use generic API key setup
        vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY,
        });
      }
    });

    this.addListener(ELEMENT_IDS.API_KEY_GUIDE_BUTTON, 'click', () => {
      // Get provider from banner element to determine which action to take
      const banner = document.getElementById(ELEMENT_IDS.API_KEY_BANNER);
      const provider = banner?.dataset?.provider;

      if (provider) {
        // Provider-specific context - open provider's API key page
        vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL,
          provider,
        });
      } else {
        // General context - open TeXRA's API key guide
        vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE,
        });
      }
    });

    this.addListener(ELEMENT_IDS.AGENT_CONFIG_EDIT_BUTTON, 'click', () => {
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      });
    });

    this.addListener(ELEMENT_IDS.AGENT_CONFIG_DIR_BUTTON, 'click', () => {
      const banner = document.getElementById(ELEMENT_IDS.AGENT_CONFIG_BANNER);
      const customDirSet = banner?.dataset?.customDirSet === 'true';
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
        customDirSet,
      });
    });

    this.addListener(ELEMENT_IDS.AGENT_CONFIG_DOC_BUTTON, 'click', () => {
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS,
      });
    });
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
    this.cleanup();
  }
}

export const mainViewDomHandler = new MainViewDomHandler();

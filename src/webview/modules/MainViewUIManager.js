import { mainViewState } from './mainViewState.js';
import { vscode } from '@common/webviewContext.js';
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';

/**
 * Consolidated UI manager for main view components
 */
export class MainViewUIManager {
  constructor() {
    this.fileManagement = new FileManagementManager();
    this.settings = new SettingsManager();
    this.recording = new RecordingManager();
    this.instruction = new InstructionManager();
    this.toolbar = new ToolbarManager();
  }

  /**
   * Coordinated update of all UI components
   */
  updateAll(state) {
    this.fileManagement.updateFileState(state);
    this.settings.updateSettings(state);
    this.instruction.updateInstructionText(state.instruction);
  }

  // Delegate methods for specific updates
  updateFileList(fileType, files) {
    this.fileManagement.updateFileList(fileType, files);
  }

  updateSelectedFile(fileType, file) {
    this.fileManagement.updateSelectedFile(fileType, file);
  }

  updateTheme(theme) {
    document.body.className = theme;
  }

  updateDebugMode(debugMode) {
    this.settings.updateDebugMode(debugMode);
  }
}

/**
 * Manages file operations and file lists
 */
class FileManagementManager {
  updateFileState(state) {
    // Update all file selects and lists based on state
    Object.keys(state).forEach((key) => {
      if (key.endsWith('Files') && Array.isArray(state[key])) {
        this.updateFileList(key.replace('Files', ''), state[key]);
      } else if (key.endsWith('File') && typeof state[key] === 'string') {
        this.updateSelectedFile(key.replace('File', ''), state[key]);
      }
    });
  }

  updateFileList(fileType, files) {
    fileList.update(
      `${fileType}Files`,
      `toggle${this.capitalize(fileType)}Files`,
      files,
    );
  }

  updateSelectedFile(fileType, file) {
    const elementId = `${fileType}File`;
    const element = document.getElementById(elementId);
    if (element) {
      element.value = file || '';
    }
  }

  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

/**
 * Manages settings and configuration UI
 */
class SettingsManager {
  updateSettings(state) {
    this.updateCheckboxes(state);
    this.updateSelects(state);
  }

  updateCheckboxes(state) {
    const checkboxes = [
      'autoExtractFigure',
      'autoExtractTikzFigure',
      'autoCompileInputPdf',
      'attachTeXCount',
      'usePrefillFromInput',
      'printInputPrompt',
      'reflect',
    ];

    checkboxes.forEach((id) => {
      const element = document.getElementById(id);
      if (element && typeof state[id] === 'boolean') {
        element.checked = state[id];
      }
    });
  }

  updateSelects(state) {
    ['agent', 'model'].forEach((id) => {
      const element = document.getElementById(id);
      if (element && state[id]) {
        element.value = state[id];
      }
    });
  }

  updateDebugMode(debugMode) {
    // Update debug mode specific UI elements
    const debugElements = document.querySelectorAll('.debug-only');
    debugElements.forEach((element) => {
      element.style.display = debugMode ? 'block' : 'none';
    });
  }
}

/**
 * Manages recording functionality UI
 */
class RecordingManager {
  updateRecordingState(isRecording) {
    const recordButton = document.getElementById('recordButton');
    const stopButton = document.getElementById('stopRecordButton');

    if (recordButton) {
      recordButton.disabled = isRecording;
      recordButton.classList.toggle('recording', isRecording);
    }

    if (stopButton) {
      stopButton.disabled = !isRecording;
      stopButton.style.display = isRecording ? 'block' : 'none';
    }
  }
}

/**
 * Manages instruction text area
 */
class InstructionManager {
  updateInstructionText(text) {
    const instructionElement = document.getElementById('instruction');
    if (instructionElement && text) {
      instructionElement.value = text;
    }
  }

  getInstructionText() {
    const instructionElement = document.getElementById('instruction');
    return instructionElement ? instructionElement.value : '';
  }
}

/**
 * Manages toolbar and action buttons
 */
class ToolbarManager {
  updateButtonStates(state) {
    this.updateExecuteButton(state);
    this.updateFileButtons(state);
  }

  updateExecuteButton(state) {
    const executeButton = document.getElementById('executeButton');
    if (executeButton) {
      const canExecute =
        state.agent && state.model && (state.inputFile || state.instruction);
      executeButton.disabled = !canExecute;
    }
  }

  updateFileButtons(state) {
    const hasInputFile = Boolean(state.inputFile);
    const buttons = ['compareButton', 'mergeButton', 'latexdiffButton'];

    buttons.forEach((buttonId) => {
      const button = document.getElementById(buttonId);
      if (button) {
        button.disabled = !hasInputFile;
      }
    });
  }
}

// Export singleton instance
export const mainViewUIManager = new MainViewUIManager();

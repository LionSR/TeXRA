// Local imports
import { vscode } from '@common/webviewContext.js';
import { COMMANDS } from '../constants.js';

/**
 * Deep module that encapsulates all user interaction logic for input status messages.
 * Hides event delegation, file opening logic, and error handling complexity.
 */
export class InputStatusInteractionHandler {
  constructor() {
    this._setupEventDelegation();
  }

  /**
   * Simple interface for external callers
   * Implementation complexity is hidden
   */
  initialize() {
    // Initialization logic is encapsulated
    this._validateEnvironment();
  }

  /**
   * Handle file path click - encapsulates all click logic
   */
  handleFileClick(filePath) {
    try {
      this._openFile(filePath);
    } catch (error) {
      console.error(
        'InputStatusInteractionHandler: Failed to open file:',
        error,
      );
    }
  }

  // Private methods hide implementation details
  _setupEventDelegation() {
    const logContent = document.getElementById('logContent');
    if (!logContent) return;

    // Use event delegation for better performance
    logContent.addEventListener('click', (e) => {
      const clickableFilePath = e.target.closest('.clickable-file-path');
      if (clickableFilePath) {
        e.preventDefault();
        e.stopPropagation();

        const filePath = clickableFilePath.dataset.filePath;
        if (filePath) {
          this.handleFileClick(filePath);
        }
      }
    });
  }

  _openFile(filePath) {
    vscode.postMessage({
      command: COMMANDS.OPEN_INPUT_FILE,
      file: filePath,
    });
  }

  _validateEnvironment() {
    if (typeof vscode === 'undefined') {
      throw new Error('VSCode API not available');
    }
  }
}

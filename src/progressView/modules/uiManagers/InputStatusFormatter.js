// Local imports
import { EMOJI_BY_LEVEL } from '../formatters.js';
import { INPUT_STATUS } from '../constants.js';

/**
 * Deep module that encapsulates all input status message formatting logic.
 * Hides complex formatting rules, file path processing, and HTML generation.
 */
export class InputStatusFormatter {
  constructor() {
    this._filePathRegex =
      /([a-zA-Z0-9._/-]+\.(tex|pdf|png|jpg|jpeg|cls|sty|bib))/g;
  }

  /**
   * Format input status payload into display message
   * Simple interface hides complex formatting logic
   */
  format(payload) {
    const { type, files, round } = payload;
    const foundFiles = files.filter((f) => f.found);
    const missingFiles = files.filter((f) => !f.found);

    return this._createFormattedMessage(type, foundFiles, missingFiles, round);
  }

  /**
   * Create log message data structure from payload
   * Encapsulates message structure knowledge
   */
  createLogMessage(payload) {
    const { timestamp, type, files } = payload;
    const missingFiles = files.filter((f) => !f.found);

    return {
      id: this._generateId(),
      text: this.format(payload),
      level: missingFiles.length > 0 ? 'warn' : 'info',
      timestamp,
      messageType: INPUT_STATUS.MESSAGE_TYPE,
      verbose: false,
    };
  }

  /**
   * Make file paths clickable in formatted text
   * Handles both found and missing files appropriately
   */
  makeClickable(text) {
    return text.replace(this._filePathRegex, (match, filePath) => {
      return `<span class="clickable-file-path" data-file-path="${filePath}">${filePath}</span>`;
    });
  }

  // Private methods hide implementation complexity
  _createFormattedMessage(type, foundFiles, missingFiles, round) {
    const roundIndicator = `<span class="round-indicator">[r${round}]</span>`;

    if (type === INPUT_STATUS.TYPES.REQUIRED) {
      return this._formatRequiredFiles(
        roundIndicator,
        foundFiles,
        missingFiles,
      );
    } else {
      return this._formatMediaFiles(roundIndicator, foundFiles);
    }
  }

  _formatRequiredFiles(roundIndicator, foundFiles, missingFiles) {
    const foundCount = foundFiles.length;
    const missingCount = missingFiles.length;

    let message = `${roundIndicator} Required Files: `;

    if (foundCount > 0) {
      message += `✓ ${foundCount} found`;
    }

    if (missingCount > 0) {
      message +=
        foundCount > 0
          ? `, ⚠ ${missingCount} missing`
          : `⚠ ${missingCount} missing`;
    }

    // Add file lists with proper formatting
    if (foundFiles.length > 0) {
      const foundList = foundFiles.map((f) => f.path).join(', ');
      message += `\n    Found: ${foundList}`;
    }

    if (missingFiles.length > 0) {
      const missingList = missingFiles.map((f) => f.path).join(', ');
      message += `\n    Missing: ${missingList}`;
    }

    return message;
  }

  _formatMediaFiles(roundIndicator, foundFiles) {
    const count = foundFiles.length;
    const fileList = foundFiles.map((f) => f.path).join(', ');

    return `${roundIndicator} Added Media: ${count} file${count !== 1 ? 's' : ''}\n    ${fileList}`;
  }

  _generateId() {
    return (
      'input-status-' +
      Date.now() +
      '-' +
      Math.random().toString(36).substr(2, 9)
    );
  }
}

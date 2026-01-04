// Local imports - webview
import { ELEMENT_IDS, EDITED_FILE } from '../constants.js';
import { mainViewState } from '../mainViewState.js';
import {
  safeGetElementById,
  safeSetElementValue,
  setElementsDisabled,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
// Local imports
import { vscode } from '@common/webviewContext.js';

/**
 * Handles single-file dropdown updates and commit list logic.
 */
export class FileSelect {
  constructor() {
    this._agentDefaults = [];
    this._manualCommitSelection = null;
  }

  setAgentDefaultOutputFiles(files) {
    this._agentDefaults = Array.isArray(files) ? files : [];
  }

  getAgentDefaultOutputFiles() {
    return this._agentDefaults;
  }

  /**
   * Updates a file select dropdown with new options and restores selection if possible.
   * @param {string} id - The DOM element ID
   * @param {string[]} files - Array of file paths to populate
   * @param {Object} [options] - Restoration options
   * @param {string} [options.storedValue] - Value from saved state (highest priority)
   * @param {string} [options.currentValue] - Current UI value (fallback priority)
   * @returns {string|null} The restored value, or null if no restoration was possible
   */
  update(id, files, options = {}) {
    const selectDiv = document.getElementById(id);
    if (!selectDiv) {
      console.warn(`[FileSelect] Element with id '${id}' not found`);
      return null;
    }

    const normalizedFiles = Array.isArray(files) ? files : [];
    const sortedFiles = [...normalizedFiles].sort((a, b) => a.localeCompare(b));

    // Determine which value to restore BEFORE adding options.
    // We set 'selected' on the option element when creating it because
    // vscode-single-select's _setStateFromSlottedElements reads this property
    // during slot change and defaults to index 0 if none found.
    const { storedValue, currentValue } = options;
    const restoredValue =
      (storedValue && sortedFiles.includes(storedValue) && storedValue) ||
      (currentValue && sortedFiles.includes(currentValue) && currentValue) ||
      null;

    console.log(`[FileSelect.update] id=${id}, files=${sortedFiles.length}, storedValue=${storedValue}, currentValue=${currentValue}, restoredValue=${restoredValue}`);

    // Block saves during option updates - vscode-single-select fires change events
    // when innerHTML is cleared, which would trigger save() with temporary "None" state
    mainViewState.blockSave();
    try {
      selectDiv.innerHTML = '';
      this.addOption(selectDiv, '', 'None');
      sortedFiles.forEach((f) =>
        this.addOption(selectDiv, f, f, f === restoredValue),
      );

      // Always set .value for synchronous access by callers.
      // Setting selected=true on options works for slotchange (async), but callers
      // reading selectDiv.value immediately after update() need the value set now.
      // Use restoredValue if available, otherwise default to empty string (None).
      selectDiv.value = restoredValue ?? '';
      if (restoredValue) {
        mainViewState.update({ [id]: restoredValue });
      }
    } finally {
      mainViewState.unblockSave();
    }

    // Return the restored value so callers don't need to read from DOM
    // (vscode-single-select doesn't reflect .value changes immediately)
    return restoredValue;
  }

  updateEdited(baseFile) {
    const editedFileDiv = safeGetElementById(EDITED_FILE);
    if (!editedFileDiv) return;
    if (baseFile) {
      const current = editedFileDiv.value;
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE,
        baseFile,
        preserveSelection: current,
      });
    } else {
      this.update(EDITED_FILE, []);
    }
  }

  /**
   * Adds an option to a select element.
   * @param {HTMLElement} select - The select element
   * @param {string} value - The option value
   * @param {string} text - The option display text
   * @param {boolean} [selected=false] - Whether this option should be selected.
   *   Must set both attribute AND property for vscode-single-select to pick it up
   *   during slotchange (_setStateFromSlottedElements reads the selected attribute).
   */
  addOption(select, value, text, selected = false) {
    if (!select) {
      return;
    }
    const option = document.createElement('vscode-option');
    option.value = value;
    option.textContent = text;
    if (selected) {
      // Set both attribute and property for vscode-single-select compatibility
      option.setAttribute('selected', '');
      option.selected = true;
    }
    select.appendChild(option);
  }

  handleRecentCommits(message) {
    const commitButtons = [
      ELEMENT_IDS.PACK_LATEXDIFF_VC_BUTTON,
      ELEMENT_IDS.CLEAN_LATEXDIFF_VC_BUTTON,
      ELEMENT_IDS.LATEXDIFF_VC_BUTTON,
    ];
    const commitDiv = document.getElementById(ELEMENT_IDS.COMMIT_SELECT);
    commitDiv.innerHTML = '';

    if (message.isGitRepo === false) {
      this.addOption(commitDiv, '', 'Not a Git repository');
      setElementsDisabled([commitDiv, ...commitButtons], true);
      this._manualCommitSelection = null;
    } else {
      this.addOption(commitDiv, 'HEAD', 'HEAD');
      message.commits.forEach((commit) => {
        const [commitHash] = commit.split(': ');
        this.addOption(commitDiv, commitHash, commit);
      });

      const manualSelection = this._manualCommitSelection;
      if (manualSelection) {
        const options = Array.from(commitDiv.querySelectorAll('vscode-option'));
        const existingOption = options.find((option) =>
          this._areEquivalentCommitHashes(
            option.value,
            manualSelection.commitHash,
          ),
        );

        if (!existingOption) {
          // Add new option with selected=true
          this.addOption(
            commitDiv,
            manualSelection.commitHash,
            manualSelection.commitLabel,
            true,
          );
        } else {
          if (
            manualSelection.commitLabel &&
            existingOption.textContent !== manualSelection.commitLabel
          ) {
            existingOption.textContent = manualSelection.commitLabel;
          }
          // For existing options, setting .selected doesn't trigger slotchange.
          // We must set the parent's .value to update the component.
          commitDiv.value = manualSelection.commitHash;
        }
      }
      setElementsDisabled([commitDiv, ...commitButtons], false);
    }
  }

  handleSetCurrentFile({ fileType, filePath }) {
    const fileId = `${uncapitalize(fileType)}File`;
    const fileDiv = document.getElementById(fileId);
    if (!fileDiv) {
      console.warn(`Element with id '${fileId}' not found`);
      return;
    }

    const options = Array.from(fileDiv.querySelectorAll('vscode-option'));
    if (options.some((o) => o.value === filePath)) {
      safeSetElementValue(fileId, filePath);
      fileDiv.dispatchEvent(new Event('change'));
    } else {
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: `The current file is not in the ${fileType} file list: ${filePath}`,
      });
    }
  }

  handleSetSelectedCommit({ commitHash, commitLabel }) {
    const commitDiv = document.getElementById(ELEMENT_IDS.COMMIT_SELECT);
    if (!commitDiv || !commitHash) {
      return;
    }

    const options = Array.from(commitDiv.querySelectorAll('vscode-option'));
    const existingOption = options.find((option) =>
      this._areEquivalentCommitHashes(option.value, commitHash),
    );

    if (!existingOption) {
      this.addOption(commitDiv, commitHash, commitLabel || commitHash, true);
    } else {
      if (commitLabel) {
        existingOption.textContent = commitLabel;
      }
    }

    // For existing options, setting .selected doesn't trigger slotchange.
    // We must set .value to update the component. For new options, this is
    // redundant but harmless since addOption already set selected=true.
    commitDiv.value = commitHash;

    this._manualCommitSelection = {
      commitHash,
      commitLabel: commitLabel || commitHash,
    };

    commitDiv.dispatchEvent(new Event('change'));
  }

  _areEquivalentCommitHashes(hashA, hashB) {
    if (!hashA || !hashB) {
      return false;
    }

    const normalizedA = hashA.trim();
    const normalizedB = hashB.trim();

    if (normalizedA === normalizedB) {
      return true;
    }

    return (
      normalizedA.startsWith(normalizedB) || normalizedB.startsWith(normalizedA)
    );
  }
}

export const fileSelect = new FileSelect();

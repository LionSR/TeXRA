// Local imports
import { vscode } from '@common/webviewContext.js';
import { safeGetElementById, safeSetElementValue } from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { webviewState } from '../webviewState.js';

/**
 * Handles single-file dropdown updates and commit list logic.
 */
export class FileSelect {
  constructor() {
    this._agentDefaults = webviewState.get()?.agentDefaultOutputFiles ?? [];
  }

  setAgentDefaultOutputFiles(files) {
    this._agentDefaults = Array.isArray(files) ? files : [];
    webviewState.update({ agentDefaultOutputFiles: this._agentDefaults });
    webviewState.save();
  }

  getAgentDefaultOutputFiles() {
    return this._agentDefaults;
  }

  /**
   * Update a single-file select element
   * @param {string} id - The select element ID
   * @param {string[]} files - Options to populate
   */
  update(id, files) {
    const selectDiv = safeGetElementById(id);
    if (!selectDiv) return;
    selectDiv.innerHTML =
      '<option value="">None</option>' +
      files.map((f) => `<option value="${f}">${f}</option>`).join('');
  }

  /**
   * Request edited file list when base file changes
   * @param {string} baseFile - Currently selected base file
   */
  updateEdited(baseFile) {
    const editedFileDiv = safeGetElementById('editedFile');
    if (!editedFileDiv) return;
    if (baseFile) {
      const current = editedFileDiv.value;
      vscode.postMessage({
        command: 'requestEditedFile',
        baseFile,
        preserveSelection: current,
      });
    } else {
      this.update('editedFile', []);
    }
  }

  /**
   * Append an option element to a select
   * @param {HTMLSelectElement} select
   * @param {string} value
   * @param {string} text
   */
  addOption(select, value, text) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }

  /**
   * Enable or disable a list of elements
   * @param {(HTMLElement|string)[]} elements
   * @param {boolean} disabled
   */
  setElementsDisabled(elements, disabled) {
    elements.forEach((el) => {
      if (typeof el === 'string') {
        const elem = document.getElementById(el);
        if (elem) elem.disabled = disabled;
      } else {
        el.disabled = disabled;
      }
    });
  }

  /**
   * Populate commit dropdown with recent commits
   * @param {object} message
   */
  handleRecentCommits(message) {
    const commitButtons = [
      'packLatexdiffvcButton',
      'cleanLatexdiffvcButton',
      'latexdiffvcButton',
    ];
    const commitDiv = document.getElementById('commit');
    commitDiv.innerHTML = '';

    if (message.isGitRepo === false) {
      this.addOption(commitDiv, '', 'Not a Git repository');
      this.setElementsDisabled([commitDiv, ...commitButtons], true);
    } else {
      this.addOption(commitDiv, 'HEAD', 'HEAD');
      message.commits.forEach((commit) => {
        const [commitHash] = commit.split(': ');
        this.addOption(commitDiv, commitHash, commit);
      });
      this.setElementsDisabled([commitDiv, ...commitButtons], false);
    }
  }

  /**
   * Highlight the current file in its dropdown
   * @param {object} param0
   * @param {string} param0.fileType
   * @param {string} param0.filePath
   */
  handleSetCurrentFile({ fileType, filePath }) {
    const fileId = `${uncapitalize(fileType)}File`;
    const fileDiv = document.getElementById(fileId);
    if (!fileDiv) {
      console.warn(`Element with id '${fileId}' not found`);
      return;
    }

    const options = Array.from(fileDiv.options);
    if (options.some((o) => o.value === filePath)) {
      safeSetElementValue(fileId, filePath);
      fileDiv.dispatchEvent(new Event('change'));
    } else {
      vscode.postMessage({
        command: 'showInformationMessage',
        text: `The current file is not in the ${fileType} file list: ${filePath}`,
      });
    }
  }
}

export const fileSelect = new FileSelect();

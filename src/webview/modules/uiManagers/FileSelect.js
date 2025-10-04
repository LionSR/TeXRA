// Local imports - webview
import { ELEMENT_IDS, EDITED_FILE } from '../constants.js';
import {
  safeGetElementById,
  safeSetElementValue,
  setElementsDisabled,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';
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

  update(id, files) {
    const selectDiv = document.getElementById(id);
    if (!selectDiv) {
      console.warn(`[FileSelect] Element with id '${id}' not found`);
      return;
    }
    selectDiv.innerHTML = '';
    this.addOption(selectDiv, '', 'None');
    files.forEach((f) => this.addOption(selectDiv, f, f));
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

  addOption(select, value, text) {
    const option = createFromTemplate('selectOptionTemplate', {
      text: { '': text },
      attributes: { '': { value } },
    });
    if (option) select.appendChild(option);
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
        const hasManualCommit = message.commits.some((commit) =>
          commit.startsWith(`${manualSelection.commitHash}:`),
        );
        if (!hasManualCommit) {
          this.addOption(
            commitDiv,
            manualSelection.commitHash,
            manualSelection.commitLabel,
          );
        }
        safeSetElementValue(
          ELEMENT_IDS.COMMIT_SELECT,
          manualSelection.commitHash,
        );
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

    const options = Array.from(fileDiv.options);
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

    const options = Array.from(commitDiv.options);
    const existingOption = options.find(
      (option) => option.value === commitHash,
    );

    if (!existingOption) {
      this.addOption(commitDiv, commitHash, commitLabel || commitHash);
    } else if (commitLabel) {
      existingOption.text = commitLabel;
    }

    safeSetElementValue(ELEMENT_IDS.COMMIT_SELECT, commitHash);
    this._manualCommitSelection = {
      commitHash,
      commitLabel: commitLabel || commitHash,
    };

    commitDiv.dispatchEvent(new Event('change'));
  }
}

export const fileSelect = new FileSelect();

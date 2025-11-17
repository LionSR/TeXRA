// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
// Local imports
import { createFromTemplate } from '@common/templateUtils.js';
import { vscode } from '@common/webviewContext.js';
import { getBasename } from '@common/pathUtils.js';
import { getEffectiveBaseFile } from '@common/modules/files/baseFileUtils.js';

/**
 * Manages file list rendering.
 * Updated to use new OutputFileInfo structure (no duplicate path fields).
 */
export class FileList {
  /**
   * Update the generated files list
   * @param {Object} filesByRound - Files organized by round
   */
  update(filesByRound) {
    const container = document.getElementById(ELEMENT_IDS.GENERATED_FILES);
    if (!container) return;

    container.innerHTML = '';

    const template = document.getElementById(ELEMENT_IDS.FILE_ITEM_TEMPLATE);
    if (!template) {
      console.error('File item template not found');
      return;
    }

    if (!filesByRound || Object.keys(filesByRound).length === 0) {
      container.textContent = 'No generated files';
      return;
    }

    const rounds = Object.keys(filesByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    rounds.forEach((round) => {
      const files = filesByRound[round];
      if (!Array.isArray(files)) {
        if (files !== undefined) {
          console.warn(
            `FileList.update: Expected array for round ${round}, got:`,
            typeof files,
            files,
          );
        }
        return;
      }
      if (files.length === 0) return;

      const roundGroup = createFromTemplate('roundHeaderTemplate');
      if (!roundGroup) return;
      const roundHeader = roundGroup.querySelector('.round-header');
      if (roundHeader) roundHeader.textContent = `r${round}`;

      files.forEach((file) => {
        // Skip invalid file entries - trust the data structure
        if (!file || !file.location) {
          console.warn('FileList.update: Invalid file entry:', file);
          return;
        }

        const clone = template.content.cloneNode(true);
        const fileItem = clone.querySelector('.file-item');
        const filePathSpan = clone.querySelector('.file-path');
        const dirSpan = clone.querySelector('.file-dir');
        const basenameSpan = clone.querySelector('.file-basename');
        const fileActions = clone.querySelector('.file-actions');
        const statsSpan = clone.querySelector('.file-stats');

        // Use source name if available, otherwise use basename of relative path
        const displayLabel =
          file.source || getBasename(file.location.relativePath);
        const relativePath = file.location.relativePath;
        const dirPath =
          relativePath && relativePath.includes('/')
            ? relativePath.substring(0, relativePath.lastIndexOf('/'))
            : '';

        // Set file data attributes using new structure
        if (fileItem) {
          fileItem.dataset.file = file.location.absolutePath;
          fileItem.dataset.original =
            file.lineage?.original?.absolutePath || '';
          fileItem.dataset.base = file.lineage?.base?.absolutePath || '';
          fileItem.dataset.round = round;
          if (file.location.kind === 'workspace') {
            fileItem.dataset.workspace = file.location.absolutePath;
          }
          if (
            file.location.kind === 'workspace' ||
            file.location.kind === 'runStorage'
          ) {
            fileItem.dataset.relative = file.location.relativePath;
          }
        }

        // Set the file path display
        if (dirSpan) dirSpan.textContent = dirPath ? `${dirPath}/` : '';
        if (basenameSpan) basenameSpan.textContent = displayLabel;
        if (filePathSpan) {
          const displayPath =
            file.location.kind === 'workspace' ||
            file.location.kind === 'runStorage'
              ? file.location.relativePath
              : file.location.absolutePath;
          filePathSpan.title = displayPath;
        }

        // Handle diff stats (use schema field names: added/removed)
        if (statsSpan) {
          if (
            file.diff?.added !== undefined &&
            file.diff?.removed !== undefined
          ) {
            statsSpan.innerHTML = `<span class="added">+${file.diff.added}</span><span class="removed">-${file.diff.removed}</span>`;
          } else if (file.diff?.added !== undefined) {
            statsSpan.innerHTML = `<span class="added">+${file.diff.added}</span>`;
          } else {
            statsSpan.remove();
          }
        }

        // Get effective base file for comparisons
        const effectiveBase = getEffectiveBaseFile(
          file.lineage?.base?.absolutePath,
          file.lineage?.original?.absolutePath,
          file.location.absolutePath,
        );

        // Update buttons with click handlers
        this.updateFileButtons(clone, file, effectiveBase);

        roundGroup.appendChild(clone);
      });

      // Append the round group to the container
      container.appendChild(roundGroup);
    });
  }

  /**
   * Update action buttons for a file item based on file state
   * @private
   */
  updateFileButtons(clone, file, effectiveBase) {
    const buttonConfigs = [
      {
        selector: '.compare-btn',
        command: COMMANDS.COMPARE_ORIGINAL,
        condition: effectiveBase,
      },
      {
        selector: '.accept-btn',
        command: COMMANDS.ACCEPT_FILE,
        condition: effectiveBase,
      },
      {
        selector: '.merge-btn',
        command: COMMANDS.MERGE_FILE,
        condition: effectiveBase,
      },
      {
        selector: '.diff-btn',
        command: COMMANDS.LATEXDIFF_FILE,
        condition: effectiveBase,
      },
      {
        selector: '.prev-btn',
        command: COMMANDS.COMPARE_PREVIOUS,
        condition: file.lineage?.previous?.absolutePath,
        configure: (btn, basePath) => {
          btn.dataset.prev = file.lineage?.previous?.absolutePath;
          if (basePath) {
            btn.dataset.base = basePath;
          }
        },
      },
    ];

    buttonConfigs.forEach(({ selector, command, condition, configure }) => {
      const button = clone.querySelector(selector);
      if (!button) {
        return;
      }
      if (condition) {
        button.dataset.command = command;
        button.dataset.file = file.location.absolutePath;
        if (configure) {
          configure(button, effectiveBase);
        } else {
          button.dataset.base = effectiveBase;
        }
      } else {
        button.style.display = 'none';
      }
    });

    // Add dataset for the file path link
    const filePathSpan = clone.querySelector('.file-path');
    if (filePathSpan) {
      filePathSpan.classList.add('clickable-link');
      filePathSpan.dataset.command = COMMANDS.OPEN_FILE;
      filePathSpan.dataset.file = file.location.absolutePath;
    }
  }
}

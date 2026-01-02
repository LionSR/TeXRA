// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
// Local imports
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Manages file list rendering.
 * Uses native VS Code collapsible for the container.
 */
export class FileList {
  /**
   * Update the generated files list
   * @param {Object} filesByRound - Files organized by round
   * @param {Object} [options] - Display options
   * @param {boolean} [options.showRoundHeaders=true] - Whether to show round headers (e.g., "r1", "r2").
   *   For workflow agents, files are grouped per round. For tool-use agents, all files are shown as a flat list.
   */
  update(filesByRound, options = {}) {
    const { showRoundHeaders = true } = options;
    const container = document.getElementById(ELEMENT_IDS.GENERATED_FILES);
    const collapsible = document.getElementById(
      ELEMENT_IDS.GENERATED_FILES_COLLAPSIBLE,
    );
    if (!container) return;

    container.innerHTML = '';

    const template = document.getElementById(ELEMENT_IDS.FILE_ITEM_TEMPLATE);
    if (!template) {
      console.error('File item template not found');
      return;
    }

    if (!filesByRound || Object.keys(filesByRound).length === 0) {
      // Hide the collapsible when there are no files
      if (collapsible) {
        collapsible.hidden = true;
      }
      return;
    }

    // Show the collapsible when there are files
    if (collapsible) {
      collapsible.hidden = false;
    }

    const rounds = Object.keys(filesByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    // Tool-use mode: create a single flat container without round headers
    // Workflow mode: each round gets its own container with a header
    let flatGroup = null;
    if (!showRoundHeaders) {
      flatGroup = createFromTemplate('roundHeaderTemplate');
      if (!flatGroup) return;
      const roundHeader = flatGroup.querySelector('.round-header');
      if (roundHeader) {
        roundHeader.remove();
      }
    }

    let hasFiles = false;
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

      hasFiles = true;

      if (showRoundHeaders) {
        // Workflow mode: create new round group with header for each round
        const roundGroup = createFromTemplate('roundHeaderTemplate');
        if (!roundGroup) return;
        const roundHeader = roundGroup.querySelector('.round-header');
        if (roundHeader) {
          roundHeader.textContent = `r${round}`;
        }

        files.forEach((file) => {
          this._renderFileItem(template, roundGroup, file, round);
        });

        container.appendChild(roundGroup);
      } else {
        // Tool-use mode: append directly to flat group
        files.forEach((file) => {
          this._renderFileItem(template, flatGroup, file, round);
        });
      }
    });

    // Append flat group only if it has files
    if (!showRoundHeaders && flatGroup && hasFiles) {
      container.appendChild(flatGroup);
    }
  }

  /**
   * Render a single file item and append it to the parent element
   * @private
   */
  _renderFileItem(template, parent, file, round) {
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
    const statsSpan = clone.querySelector('.file-stats');

    const relativePath = file.location.relativePath;

    // Set file data attributes using new structure
    if (fileItem) {
      fileItem.dataset.file = file.location.absolutePath;
      fileItem.dataset.original = file.lineage?.original?.absolutePath || '';
      fileItem.dataset.base = file.lineage?.diffBase?.absolutePath || '';
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

    // Set the file path display - simplified, no color coding for directory
    if (basenameSpan) basenameSpan.textContent = relativePath;
    if (dirSpan) dirSpan.textContent = '';
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
      if (file.diff?.added !== undefined && file.diff?.removed !== undefined) {
        statsSpan.innerHTML = `<span class="added">+${file.diff.added}</span><span class="removed">-${file.diff.removed}</span>`;
      } else if (file.diff?.added !== undefined) {
        statsSpan.innerHTML = `<span class="added">+${file.diff.added}</span>`;
      } else {
        statsSpan.remove();
      }
    }

    // Get effective base file for comparisons
    // NEW STRUCTURE: diffBase is already computed, use it directly
    const effectiveBase =
      file.lineage?.diffBase?.absolutePath ||
      file.lineage?.original?.absolutePath;

    // Update buttons with click handlers
    this.updateFileButtons(clone, file, effectiveBase);

    parent.appendChild(clone);
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
        condition: file.lineage?.diffBase?.absolutePath,
        configure: (btn, basePath) => {
          btn.dataset.prev = file.lineage?.diffBase?.absolutePath;
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

  /**
   * Clear the file list and hide the collapsible container.
   */
  clear() {
    const container = document.getElementById(ELEMENT_IDS.GENERATED_FILES);
    const collapsible = document.getElementById(
      ELEMENT_IDS.GENERATED_FILES_COLLAPSIBLE,
    );
    if (container) {
      container.innerHTML = '';
    }
    if (collapsible) {
      collapsible.hidden = true;
    }
  }
}

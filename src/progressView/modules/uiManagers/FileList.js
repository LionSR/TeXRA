// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
// Local imports
import { createFromTemplate } from '@common/templateUtils.js';
import { setVisibilityState } from '@common/domUtils.js';

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
      setVisibilityState(collapsible, false);
      return;
    }

    const rounds = Object.keys(filesByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    let hasFiles = false;
    for (const round of rounds) {
      const files = filesByRound[round];
      if (!Array.isArray(files) || files.length === 0) continue;

      hasFiles = true;

      // Determine target container based on mode
      let target = container;
      if (showRoundHeaders) {
        const roundGroup = createFromTemplate('roundHeaderTemplate');
        if (!roundGroup) continue;
        roundGroup.setAttribute('title', `r${round}`);
        const roundContent = roundGroup.querySelector('.round-content');
        if (!roundContent) continue;
        target = roundContent;
        container.appendChild(roundGroup);
      }

      files.forEach((file) => this._renderFileItem(template, target, file, round));
    }

    // Show/hide collapsible based on whether files were actually rendered
    setVisibilityState(collapsible, hasFiles);
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
      const statsHtml = this._buildDiffStatsHtml(file.diff);
      if (statsHtml) {
        statsSpan.innerHTML = statsHtml;
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
    const filePath = file.location.absolutePath;
    const diffBase = file.lineage?.diffBase?.absolutePath;

    // Standard buttons that use effectiveBase
    const standardButtons = [
      { selector: '.compare-btn', command: COMMANDS.COMPARE_ORIGINAL },
      { selector: '.accept-btn', command: COMMANDS.ACCEPT_FILE },
      { selector: '.merge-btn', command: COMMANDS.MERGE_FILE },
      { selector: '.diff-btn', command: COMMANDS.LATEXDIFF_FILE },
    ];

    for (const { selector, command } of standardButtons) {
      const btn = clone.querySelector(selector);
      if (!btn) continue;
      if (effectiveBase) {
        btn.dataset.command = command;
        btn.dataset.file = filePath;
        btn.dataset.base = effectiveBase;
      } else {
        btn.style.display = 'none';
      }
    }

    // Previous button has special handling
    const prevBtn = clone.querySelector('.prev-btn');
    if (prevBtn) {
      if (diffBase) {
        prevBtn.dataset.command = COMMANDS.COMPARE_PREVIOUS;
        prevBtn.dataset.file = filePath;
        prevBtn.dataset.prev = diffBase;
        if (effectiveBase) prevBtn.dataset.base = effectiveBase;
      } else {
        prevBtn.style.display = 'none';
      }
    }

    // File path link
    const filePathSpan = clone.querySelector('.file-path');
    if (filePathSpan) {
      filePathSpan.classList.add('clickable-link');
      filePathSpan.dataset.command = COMMANDS.OPEN_FILE;
      filePathSpan.dataset.file = filePath;
    }
  }

  /**
   * Build HTML for diff stats display.
   * @private
   * @param {Object|undefined} diff - Diff stats with added/removed counts
   * @returns {string|null} HTML string or null if no stats to show
   */
  _buildDiffStatsHtml(diff) {
    if (diff?.added === undefined) return null;
    const addedSpan = `<span class="added">+${diff.added}</span>`;
    const removedSpan =
      diff.removed !== undefined
        ? `<span class="removed">-${diff.removed}</span>`
        : '';
    return addedSpan + removedSpan;
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
    setVisibilityState(collapsible, false);
  }
}

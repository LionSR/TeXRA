// Local imports
import { formatTokens } from '../formatters.js';
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { vscode } from '@common/webviewContext.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';

/**
 * Manages file list rendering.
 */
export class FileList {
  constructor(usageSummary = null) {
    this.usageSummary = usageSummary;
  }
  /**
   * Get the effective base file for comparison operations.
   * @param {string|null|undefined} base - The explicit base file path
   * @param {string|null|undefined} original - The original source file path
   * @param {string} current - The current generated file path
   * @returns {string|null} The effective base file path or null
   */
  getEffectiveBaseFile(base, original, current) {
    // Use explicit base if available
    if (base) {
      return base;
    }

    // Use original as base if it exists and differs from current
    if (original && original !== current) {
      return original;
    }

    return null;
  }

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

    // Add total usage header
    const usageHeader = document.createElement('div');
    usageHeader.className = 'files-usage-header';

    // Calculate total usage from all groups
    const totals = this.usageSummary?.computeTotal() || {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    if (totals.inputTokens || totals.outputTokens || totals.cost) {
      usageHeader.innerHTML = `
        <span class="files-usage-label">Total Usage:</span>
        <span class="files-usage-stats">
          <i class="codicon codicon-arrow-up"></i> ${formatTokens(totals.inputTokens)},
          <i class="codicon codicon-arrow-down"></i> ${formatTokens(totals.outputTokens)},
          $${totals.cost.toFixed(3)}
        </span>
      `;
      container.appendChild(usageHeader);
    }

    const rounds = Object.keys(filesByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    rounds.forEach((round) => {
      const files = filesByRound[round];
      if (!files || files.length === 0) return;

      const roundGroup = createFromTemplate('roundHeaderTemplate');
      if (!roundGroup) return;
      const roundHeader = roundGroup.querySelector('.round-header');
      if (roundHeader) roundHeader.textContent = `r${round}`;

      files.forEach((file) => {
        // Skip invalid file entries
        if (!file || !file.path) {
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

        // Use original name if available, otherwise use generated path
        const displayPath = file.original || file.path;
        const parts = displayPath.split('/');
        const basename = parts.pop() || '';
        const dirPath = parts.length > 0 ? parts.join('/') + '/' : '';

        // Set file data attributes
        if (fileItem) {
          fileItem.dataset.file = file.path;
          fileItem.dataset.original = file.original || '';
          fileItem.dataset.base = file.base || '';
          fileItem.dataset.round = round;
        }

        // Set the file path display
        if (dirSpan) dirSpan.textContent = dirPath;
        if (basenameSpan) basenameSpan.textContent = basename;
        if (filePathSpan) filePathSpan.title = file.path;

        // Handle file stats
        if (statsSpan) {
          if (file.added !== undefined && file.removed !== undefined) {
            statsSpan.innerHTML = `<span class="added">+${file.added}</span><span class="removed">-${file.removed}</span>`;
          } else if (file.added !== undefined) {
            statsSpan.innerHTML = `<span class="added">+${file.added}</span>`;
          } else {
            statsSpan.remove();
          }
        }

        // Get effective base file for comparisons
        const effectiveBase = this.getEffectiveBaseFile(
          file.base,
          file.original,
          file.path,
        );

        // Add data attributes for delegated click handlers
        this.updateFileButtons(clone, file, effectiveBase);

        // Replace any icon placeholders after attributes are set
        initializeIconButtons(clone);

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
    const compareBtn = clone.querySelector('.compare-btn');
    const acceptBtn = clone.querySelector('.accept-btn');
    const mergeBtn = clone.querySelector('.merge-btn');
    const diffBtn = clone.querySelector('.diff-btn');
    const prevBtn = clone.querySelector('.prev-btn');

    // Compare button - show only if there's a base file
    if (compareBtn) {
      if (effectiveBase) {
        compareBtn.dataset.command = COMMANDS.COMPARE_ORIGINAL;
        compareBtn.dataset.file = file.path;
        compareBtn.dataset.base = effectiveBase;
      } else {
        compareBtn.style.display = 'none';
      }
    }

    // Accept button - show only if there's a base file
    if (acceptBtn) {
      if (effectiveBase) {
        acceptBtn.dataset.command = COMMANDS.ACCEPT_FILE;
        acceptBtn.dataset.file = file.path;
        acceptBtn.dataset.base = effectiveBase;
      } else {
        acceptBtn.style.display = 'none';
      }
    }

    // Merge button - show only if there's a base file
    if (mergeBtn) {
      if (effectiveBase) {
        mergeBtn.dataset.command = COMMANDS.MERGE_FILE;
        mergeBtn.dataset.file = file.path;
        mergeBtn.dataset.base = effectiveBase;
      } else {
        mergeBtn.style.display = 'none';
      }
    }

    // LaTeX diff button - show only if there's a base file
    if (diffBtn) {
      if (effectiveBase) {
        diffBtn.dataset.command = COMMANDS.LATEXDIFF_FILE;
        diffBtn.dataset.file = file.path;
        diffBtn.dataset.base = effectiveBase;
      } else {
        diffBtn.style.display = 'none';
      }
    }

    // Previous round comparison button - show only if there's a previous version
    if (prevBtn) {
      if (file.prev) {
        prevBtn.dataset.command = COMMANDS.COMPARE_PREVIOUS;
        prevBtn.dataset.file = file.path;
        prevBtn.dataset.prev = file.prev;
      } else {
        prevBtn.style.display = 'none';
      }
    }

    // Add dataset for the file path link
    const filePathSpan = clone.querySelector('.file-path');
    if (filePathSpan && file.path) {
      filePathSpan.classList.add('clickable-link');
      filePathSpan.dataset.command = COMMANDS.OPEN_FILE;
      filePathSpan.dataset.file = file.path;
    }
  }
}

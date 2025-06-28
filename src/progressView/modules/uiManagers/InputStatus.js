// Local imports
import { COMMANDS } from '../constants.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages input status rendering for required files and figures.
 */
export class InputStatus {
  constructor() {
    this.statusData = new Map(); // logId -> InputStatus
  }

  /**
   * Update the input status display
   * @param {string} logId - Log message ID
   * @param {Object} status - InputStatus object
   */
  update(logId, status) {
    if (!status) return;

    // Store the status data
    this.statusData.set(logId, status);

    const container = document.getElementById('inputStatus');
    if (!container) return;

    // Find existing entry or create new one
    let statusEntry = document.getElementById(`input-status-${logId}`);
    if (!statusEntry) {
      statusEntry = this.createStatusEntry(logId, status);
      container.appendChild(statusEntry);
    } else {
      this.updateStatusEntry(statusEntry, status);
    }
  }

  /**
   * Create a new status entry element
   * @private
   */
  createStatusEntry(logId, status) {
    const entry = document.createElement('div');
    entry.className = 'input-status-entry';
    entry.id = `input-status-${logId}`;

    const header = document.createElement('div');
    header.className = 'input-status-header';
    header.onclick = () => this.toggleStatusEntry(logId);

    const icon = document.createElement('i');
    icon.className = 'codicon codicon-chevron-right input-status-icon';

    const title = document.createElement('span');
    title.className = 'input-status-title';

    const summary = this.getStatusSummary(status);
    title.textContent = summary.title;

    const badge = document.createElement('span');
    badge.className = `input-status-badge ${summary.hasErrors ? 'error' : 'success'}`;
    badge.textContent = summary.badge;

    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(badge);

    const content = document.createElement('div');
    content.className = 'input-status-content';
    content.style.display = 'none';

    this.populateStatusContent(content, status);

    entry.appendChild(header);
    entry.appendChild(content);

    return entry;
  }

  /**
   * Update an existing status entry
   * @private
   */
  updateStatusEntry(entry, status) {
    const content = entry.querySelector('.input-status-content');
    if (content) {
      content.innerHTML = '';
      this.populateStatusContent(content, status);
    }

    const title = entry.querySelector('.input-status-title');
    const badge = entry.querySelector('.input-status-badge');
    if (title && badge) {
      const summary = this.getStatusSummary(status);
      title.textContent = summary.title;
      badge.textContent = summary.badge;
      badge.className = `input-status-badge ${summary.hasErrors ? 'error' : 'success'}`;
    }
  }

  /**
   * Get summary information for status
   * @private
   */
  getStatusSummary(status) {
    const requiredFiles = status.required || [];
    const figures = status.figures || [];
    const missingCount = requiredFiles.filter((f) => !f.found).length;
    const foundCount = requiredFiles.filter((f) => f.found).length;
    const totalRequired = requiredFiles.length;
    const figureCount = figures.length;

    let title = '';
    let badge = '';
    let hasErrors = false;

    if (totalRequired > 0 && figureCount > 0) {
      title = `Files & Figures (${foundCount}/${totalRequired} files, ${figureCount} figures)`;
    } else if (totalRequired > 0) {
      title = `Required Files (${foundCount}/${totalRequired})`;
    } else if (figureCount > 0) {
      title = `Figures (${figureCount})`;
    } else {
      title = 'Input Status';
    }

    if (missingCount > 0) {
      badge = `${missingCount} missing`;
      hasErrors = true;
    } else if (totalRequired > 0 || figureCount > 0) {
      badge = 'all found';
    } else {
      badge = 'none';
    }

    return { title, badge, hasErrors };
  }

  /**
   * Populate status content with file and figure lists
   * @private
   */
  populateStatusContent(content, status) {
    const requiredFiles = status.required || [];
    const figures = status.figures || [];

    // Add required files section
    if (requiredFiles.length > 0) {
      const filesSection = document.createElement('div');
      filesSection.className = 'input-status-section';

      const filesHeader = document.createElement('h4');
      filesHeader.textContent = 'Required Files';
      filesSection.appendChild(filesHeader);

      const filesList = document.createElement('ul');
      filesList.className = 'input-status-list';

      requiredFiles.forEach((file) => {
        const item = document.createElement('li');
        item.className = `input-status-item ${file.found ? 'found' : 'missing'}`;

        const icon = document.createElement('i');
        icon.className = `codicon ${file.found ? 'codicon-check' : 'codicon-error'}`;

        const fileInfo = document.createElement('span');
        fileInfo.className = 'file-info';

        const fileName = document.createElement('span');
        fileName.className = 'file-name';
        fileName.textContent = file.path;
        fileName.onclick = () => this.openFile(file.path);

        const varName = document.createElement('span');
        varName.className = 'var-name';
        varName.textContent = `(${file.varName})`;

        fileInfo.appendChild(fileName);
        fileInfo.appendChild(varName);

        item.appendChild(icon);
        item.appendChild(fileInfo);
        filesList.appendChild(item);
      });

      filesSection.appendChild(filesList);
      content.appendChild(filesSection);
    }

    // Add figures section
    if (figures.length > 0) {
      const figuresSection = document.createElement('div');
      figuresSection.className = 'input-status-section';

      const figuresHeader = document.createElement('h4');
      figuresHeader.textContent = 'Figures';
      figuresSection.appendChild(figuresHeader);

      const figuresList = document.createElement('ul');
      figuresList.className = 'input-status-list';

      figures.forEach((figure) => {
        const item = document.createElement('li');
        item.className = 'input-status-item found';

        const icon = document.createElement('i');
        icon.className = 'codicon codicon-file-media';

        const figureName = document.createElement('span');
        figureName.className = 'file-name';
        figureName.textContent = figure.path;
        figureName.onclick = () => this.openFile(figure.path);

        item.appendChild(icon);
        item.appendChild(figureName);
        figuresList.appendChild(item);
      });

      figuresSection.appendChild(figuresList);
      content.appendChild(figuresSection);
    }
  }

  /**
   * Toggle visibility of status entry content
   * @private
   */
  toggleStatusEntry(logId) {
    const entry = document.getElementById(`input-status-${logId}`);
    if (!entry) return;

    const content = entry.querySelector('.input-status-content');
    const icon = entry.querySelector('.input-status-icon');

    if (!content || !icon) return;

    const isExpanded = content.style.display !== 'none';

    content.style.display = isExpanded ? 'none' : 'block';
    icon.className = `codicon ${isExpanded ? 'codicon-chevron-right' : 'codicon-chevron-down'} input-status-icon`;
  }

  /**
   * Open a file without triggering LaTeX compilation
   * @private
   */
  openFile(filePath) {
    vscode.postMessage({
      command: COMMANDS.OPEN_RESOURCE,
      file: filePath,
    });
  }

  /**
   * Clear all status entries
   */
  clear() {
    const container = document.getElementById('inputStatus');
    if (container) {
      container.innerHTML = '';
    }
    this.statusData.clear();
  }
}

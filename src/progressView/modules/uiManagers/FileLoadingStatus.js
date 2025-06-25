// Local imports
import { COMMANDS } from '../constants.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages file loading status display with native structured data.
 */
export class FileLoadingStatus {
  constructor() {
    this.fileStatuses = new Map(); // Map<string, FileStatusData>
    this.isVisible = false;
  }

  /**
   * Add or update a file status using structured data
   * @param {Object} fileStatusData - Structured file status data
   * @param {string} fileStatusData.variable - Variable name (e.g., 'COVER_LETTER')
   * @param {string} fileStatusData.filePath - File path
   * @param {string} fileStatusData.source - Source category (e.g., 'requiredFiles')
   * @param {boolean} fileStatusData.found - Whether the file was found
   * @param {string} [fileStatusData.patternName] - Pattern name if from pattern matching
   */
  updateFileStatus(fileStatusData) {
    if (!fileStatusData || !fileStatusData.variable) return;

    const statusEntry = {
      type: fileStatusData.found ? 'found' : 'missing',
      variable: fileStatusData.variable,
      path: fileStatusData.filePath,
      category: fileStatusData.patternName 
        ? `Pattern '${fileStatusData.patternName}'`
        : fileStatusData.source,
      timestamp: Date.now()
    };

    this.fileStatuses.set(fileStatusData.variable, statusEntry);
    this.updateDisplay();
  }

  /**
   * Clear all file statuses (e.g., when starting a new task)
   */
  clearStatuses() {
    this.fileStatuses.clear();
    this.updateDisplay();
  }

  /**
   * Get file loading status summary
   * @returns {Object} Summary with counts and files by status
   */
  getStatusSummary() {
    const summary = {
      total: this.fileStatuses.size,
      found: 0,
      missing: 0,
      foundFiles: [],
      missingFiles: []
    };

    for (const status of this.fileStatuses.values()) {
      if (status.type === 'found') {
        summary.found++;
        summary.foundFiles.push(status);
      } else {
        summary.missing++;
        summary.missingFiles.push(status);
      }
    }

    return summary;
  }

  /**
   * Create the file loading status UI element
   * @returns {HTMLElement} The status display element
   */
  createStatusDisplay() {
    const container = document.createElement('div');
    container.className = 'file-loading-status';
    container.id = 'fileLoadingStatus';

    const summary = this.getStatusSummary();
    
    if (summary.total === 0) {
      container.style.display = 'none';
      return container;
    }

    // Create header with summary
    const header = document.createElement('div');
    header.className = 'file-status-header';
    
    const title = document.createElement('h4');
    title.className = 'file-status-title';
    title.innerHTML = `
      <i class="codicon codicon-file-directory"></i>
      File Loading Status
    `;

    const summaryInfo = document.createElement('div');
    summaryInfo.className = 'file-status-summary';
    summaryInfo.innerHTML = `
      <span class="status-count found">
        <i class="codicon codicon-check"></i> ${summary.found} found
      </span>
      <span class="status-count missing">
        <i class="codicon codicon-warning"></i> ${summary.missing} missing
      </span>
    `;

    header.appendChild(title);
    header.appendChild(summaryInfo);
    container.appendChild(header);

    // Create collapsible sections
    if (summary.missingFiles.length > 0) {
      const missingSection = this.createFileSection('Missing Files', summary.missingFiles, 'missing', true);
      container.appendChild(missingSection);
    }

    if (summary.foundFiles.length > 0) {
      const foundSection = this.createFileSection('Found Files', summary.foundFiles, 'found', false);
      container.appendChild(foundSection);
    }

    return container;
  }

  /**
   * Create a collapsible section for files by status
   * @param {string} title - Section title
   * @param {Array} files - Array of file status objects
   * @param {string} type - 'found' or 'missing'
   * @param {boolean} defaultOpen - Whether section should be open by default
   * @returns {HTMLElement} The section element
   */
  createFileSection(title, files, type, defaultOpen = false) {
    const section = document.createElement('details');
    section.className = `file-section file-section-${type}`;
    if (defaultOpen) {
      section.setAttribute('open', '');
    }

    const summary = document.createElement('summary');
    summary.className = 'file-section-header';
    summary.innerHTML = `
      <i class="codicon codicon-chevron-down"></i>
      <span class="section-title">${title}</span>
      <span class="section-count">(${files.length})</span>
    `;

    const content = document.createElement('div');
    content.className = 'file-section-content';

    // Group files by category for better organization
    const filesByCategory = this.groupFilesByCategory(files);

    for (const [category, categoryFiles] of Object.entries(filesByCategory)) {
      if (Object.keys(filesByCategory).length > 1) {
        const categoryHeader = document.createElement('div');
        categoryHeader.className = 'file-category-header';
        categoryHeader.textContent = category;
        content.appendChild(categoryHeader);
      }

      const fileList = document.createElement('div');
      fileList.className = 'file-list';

      for (const file of categoryFiles) {
        const fileItem = this.createFileItem(file);
        fileList.appendChild(fileItem);
      }

      content.appendChild(fileList);
    }

    section.appendChild(summary);
    section.appendChild(content);

    return section;
  }

  /**
   * Group files by their category
   * @param {Array} files - Array of file status objects
   * @returns {Object} Files grouped by category
   */
  groupFilesByCategory(files) {
    const grouped = {};
    for (const file of files) {
      const category = file.category;
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(file);
    }
    return grouped;
  }

  /**
   * Create a single file item element
   * @param {Object} file - File status object
   * @returns {HTMLElement} The file item element
   */
  createFileItem(file) {
    const item = document.createElement('div');
    item.className = `file-item file-item-${file.type}`;

    const icon = file.type === 'found' 
      ? '<i class="codicon codicon-check file-status-icon found"></i>'
      : '<i class="codicon codicon-warning file-status-icon missing"></i>';

    const pathParts = file.path.split('/');
    const fileName = pathParts.pop();
    const dirPath = pathParts.length > 0 ? pathParts.join('/') + '/' : '';

    item.innerHTML = `
      ${icon}
      <div class="file-info">
        <div class="file-path">
          <span class="file-dir">${dirPath}</span>
          <span class="file-name">${fileName}</span>
        </div>
        <div class="file-variable">
          <code>${file.variable}</code>
        </div>
      </div>
    `;

    // Add click handler to open file if it exists
    if (file.type === 'found') {
      item.classList.add('clickable');
      item.title = 'Click to open file';
      item.addEventListener('click', () => {
        vscode.postMessage({
          command: COMMANDS.OPEN_FILE,
          file: file.path,
        });
      });
    }

    return item;
  }

  /**
   * Update the display in the DOM
   */
  updateDisplay() {
    const existingDisplay = document.getElementById('fileLoadingStatus');
    const newDisplay = this.createStatusDisplay();

    if (existingDisplay) {
      existingDisplay.replaceWith(newDisplay);
    } else {
      // Find a good place to insert the display
      const logContainer = document.getElementById('logContent');
      if (logContainer) {
        logContainer.appendChild(newDisplay);
      }
    }

    this.isVisible = newDisplay.style.display !== 'none';
  }

  /**
   * Clear all file statuses
   */
  clear() {
    this.fileStatuses.clear();
    const existingDisplay = document.getElementById('fileLoadingStatus');
    if (existingDisplay) {
      existingDisplay.remove();
    }
    this.isVisible = false;
  }

  /**
   * Show/hide the file loading status display
   * @param {boolean} visible - Whether to show the display
   */
  setVisible(visible) {
    const display = document.getElementById('fileLoadingStatus');
    if (display) {
      display.style.display = visible ? 'block' : 'none';
      this.isVisible = visible;
    }
  }

  /**
   * Handle file loading status updates from the extension
   * @param {Array} fileStatusUpdates - Array of file status data objects
   */
  handleStatusUpdates(fileStatusUpdates) {
    if (!Array.isArray(fileStatusUpdates)) return;
    
    for (const update of fileStatusUpdates) {
      this.updateFileStatus(update);
    }
  }
}
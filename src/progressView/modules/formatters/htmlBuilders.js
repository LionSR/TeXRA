/**
 * HTML generation utilities for progress view formatters.
 * These functions create HTML fragments from normalized data.
 */

import { encodeHtml } from '@common/htmlEncoding.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';

/**
 * Build a tool-use section HTML block
 * @param {string} label - The section label (e.g., "Input:", "Output:")
 * @param {string} content - The HTML content for the section
 * @returns {string} HTML string for the section
 */
export const buildToolUseSection = (label, content) => `
  <div class="tool-use-section">
    <div class="tool-use-subsection">
      <span class="tool-use-sublabel">${label}</span>
      ${content}
    </div>
  </div>
`;

/**
 * Wrap text in a pre element with optional class
 * @param {string} text - Text to wrap (will be HTML encoded)
 * @param {string} [className] - Optional CSS class
 * @returns {string} HTML string
 */
export const wrapInPre = (text, className = '') => {
  const classAttr = className ? ` class="${className}"` : '';
  return `<pre${classAttr}>${encodeHtml(text)}</pre>`;
};

/**
 * Set common dataset attributes on an element
 * @param {HTMLElement} element - The element to modify
 * @param {{logId?: string, groupId?: string, timestamp?: string}} data - Dataset values
 */
export const setElementDataset = (element, { logId, groupId, timestamp }) => {
  if (logId) element.dataset.logId = logId;
  if (groupId) element.dataset.groupId = groupId;
  if (timestamp) element.dataset.fullTimestamp = timestamp;
};

/**
 * Initialize toggle icon on a collapsible element
 * @param {HTMLElement} element - Element containing toggle icon
 * @param {boolean} [expanded=false] - Whether the element is expanded
 */
export const initToggleIcon = (element, expanded = false) => {
  const toggleIcon = element.querySelector('.toggle-icon');
  if (toggleIcon) {
    toggleIcon.className = `${
      expanded ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS
    } toggle-icon`;
  }
};

/**
 * Build rendered HTML for file list
 * @param {Array} files - Array of normalized file entries
 * @returns {{items: string, summary: string}|null} Rendered items and summary
 */
export const buildFileListRender = (files) => {
  if (!Array.isArray(files)) {
    return null;
  }

  const items = files
    .map((file) => {
      const icon = file.ok ? 'codicon-check' : 'codicon-warning';
      const escaped = encodeHtml(file.filePath);
      const fileNameEscaped = encodeHtml(file.fileName);

      let metadata = '';
      if (file.varName) {
        metadata += `<span class="file-var">[${encodeHtml(file.varName)}]</span>`;
      }
      if (file.source && file.source !== 'unknown') {
        const sourceEscaped = encodeHtml(file.sourceDisplay);
        if (file.internal) {
          metadata += ` <span class="file-source">(${sourceEscaped}, internal)</span>`;
        } else {
          metadata += ` <span class="file-source">(${sourceEscaped})</span>`;
        }
      }

      return `<li class="detail-item" title="${escaped}"><i class="codicon ${icon}"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span> ${metadata}</li>`;
    })
    .join('');

  const totalFiles = files.length;
  const loadedFiles = files.filter((file) => file.ok).length;
  const failedFiles = totalFiles - loadedFiles;

  let summary = `Files (${loadedFiles}/${totalFiles} loaded`;
  if (failedFiles > 0) {
    summary += `, ${failedFiles} not found`;
  }
  summary += ')';

  return { items, summary };
};

/**
 * Build file link HTML element
 * @param {string} filePath - Absolute file path
 * @param {string} displayName - Display name for the link
 * @returns {string} HTML string for the file link
 */
export const buildFileLink = (filePath, displayName) => {
  if (!filePath) {
    return `<span>${encodeHtml(displayName)}</span>`;
  }
  return `<span class="file-link clickable-link" data-file="${encodeHtml(filePath)}">${encodeHtml(displayName)}</span>`;
};

/**
 * Build detail list item with icon
 * @param {string} iconClass - Codicon class (e.g., 'codicon-check')
 * @param {string} content - Inner HTML content
 * @param {object} [options] - Optional attributes
 * @param {string} [options.title] - Title attribute
 * @param {string} [options.runId] - data-run-id attribute
 * @returns {string} HTML string for list item
 */
export const buildDetailItem = (iconClass, content, options = {}) => {
  const titleAttr = options.title
    ? ` title="${encodeHtml(options.title)}"`
    : '';
  const runAttr = options.runId
    ? ` data-run-id="${encodeHtml(options.runId)}"`
    : '';
  return `<li class="detail-item"${runAttr}><i class="codicon ${iconClass}"${titleAttr}></i> ${content}</li>`;
};

/**
 * Build line changes badge HTML
 * @param {{added: number, removed: number}} lineChanges - Line change statistics
 * @returns {string} HTML string for line changes badge
 */
export const buildLineChangesBadge = (lineChanges) => {
  if (!lineChanges) return '';

  const { added = 0, removed = 0 } = lineChanges;
  if (added === 0 && removed === 0) return '';

  const parts = [];
  if (added > 0) {
    parts.push(`<span class="line-change-added">+${added}</span>`);
  }
  if (removed > 0) {
    parts.push(`<span class="line-change-removed">−${removed}</span>`);
  }

  return `<span class="line-changes-badge">${parts.join(' ')}</span>`;
};

/**
 * Build edited files list HTML with clickable links and line changes
 * @param {Array} edits - Array of edit records {path, lineChanges}
 * @returns {string} HTML string for files list
 */
export const buildEditedFilesList = (edits) => {
  if (!Array.isArray(edits) || edits.length === 0) return '';

  const items = edits
    .map((edit) => {
      const path = edit.path || '';
      const fileName = path.split('/').pop() || path;
      const pathEscaped = encodeHtml(path);
      const fileNameEscaped = encodeHtml(fileName);
      const lineChangesBadge = buildLineChangesBadge(edit.lineChanges);

      return `<li class="detail-item" title="${pathEscaped}">
        <i class="codicon codicon-file"></i>
        <span class="file-link clickable-link" data-file="${pathEscaped}">${fileNameEscaped}</span>
        ${lineChangesBadge}
      </li>`;
    })
    .join('');

  return `<ul class="detail-list edited-files-list">${items}</ul>`;
};

/**
 * Format tool input for display based on tool type
 * Returns a condensed, human-readable version of the input
 * @param {string} toolName - Name of the tool
 * @param {*} input - Raw input object
 * @returns {{display: string, isCondensed: boolean}} Formatted input and whether it was condensed
 */
export const formatToolInput = (toolName, input) => {
  if (input === undefined || input === null) {
    return { display: '', isCondensed: true };
  }

  // Tool-specific condensed formats
  const condensers = {
    // File operations - just show the path
    read_file: (inp) => inp.path || inp.file_path,
    write_file: (inp) => inp.path || inp.file_path,
    edit_file: (inp) => inp.path || inp.file_path,
    file_op: (inp) => `${inp.operation || 'op'}: ${inp.path || inp.file_path || ''}`,

    // Text editor tool
    str_replace_editor: (inp) => {
      const cmd = inp.command || 'view';
      const path = inp.path || '';
      if (cmd === 'view') return `view: ${path}`;
      if (cmd === 'str_replace') return `edit: ${path}`;
      if (cmd === 'create') return `create: ${path}`;
      return `${cmd}: ${path}`;
    },

    // Search tools - show the query/pattern
    glob: (inp) => inp.pattern || inp.glob,
    grep: (inp) => `"${inp.pattern || ''}" in ${inp.path || '.'}`,
    arxiv_search: (inp) => inp.query,
    crossref_search: (inp) => inp.query,
    web_search: (inp) => inp.query,

    // Bash - show command preview
    bash: (inp) => {
      const cmd = inp.command || '';
      return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    },

    // URL-based tools
    web_fetch: (inp) => inp.url,
    arxiv_metadata: (inp) => inp.arxiv_id || inp.id,
    crossref_doi: (inp) => inp.doi,
    download_arxiv_source: (inp) => inp.arxiv_id || inp.id,

    // Directory listing
    ls: (inp) => inp.path || '.',

    // Diagnostics
    diagnostics: (inp) => inp.path || inp.file_path,

    // LaTeX tools
    texcount: (inp) => Array.isArray(inp.files) ? `${inp.files.length} file(s)` : inp.path,
    extract_figures: (inp) => inp.path || inp.file_path,
    extract_tikz_figures: (inp) => inp.path || inp.file_path,
    extract_bib_entries: (inp) => inp.path || inp.file_path,
  };

  const condenser = condensers[toolName];
  if (condenser && typeof input === 'object') {
    const condensed = condenser(input);
    if (condensed) {
      return { display: String(condensed), isCondensed: true };
    }
  }

  // Fallback: return null to signal full YAML display needed
  return { display: null, isCondensed: false };
};

/**
 * Get appropriate icon class for a tool
 * @param {string} toolName - Name of the tool
 * @param {boolean} isError - Whether the tool execution errored
 * @returns {string} Codicon class name
 */
export const getToolIconClass = (toolName, isError = false) => {
  if (isError) return 'codicon-error';

  const iconMap = {
    // File operations
    read_file: 'codicon-file',
    write_file: 'codicon-new-file',
    edit_file: 'codicon-edit',
    file_op: 'codicon-file-code',
    str_replace_editor: 'codicon-edit',

    // Search/find
    glob: 'codicon-search',
    grep: 'codicon-search',
    ls: 'codicon-folder-opened',

    // Shell
    bash: 'codicon-terminal',
    wolfram: 'codicon-symbol-operator',

    // Web/research
    web_fetch: 'codicon-globe',
    web_search: 'codicon-globe',
    arxiv_search: 'codicon-book',
    arxiv_metadata: 'codicon-book',
    download_arxiv_source: 'codicon-cloud-download',
    crossref_search: 'codicon-references',
    crossref_doi: 'codicon-references',

    // LaTeX
    texcount: 'codicon-symbol-numeric',
    extract_figures: 'codicon-file-media',
    extract_tikz_figures: 'codicon-file-media',
    extract_bib_entries: 'codicon-library',

    // Diagnostics
    diagnostics: 'codicon-checklist',

    // Task management
    todo_write: 'codicon-tasklist',
  };

  return iconMap[toolName] || 'codicon-wrench';
};

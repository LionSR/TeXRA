/**
 * HTML generation utilities for progress view formatters.
 * These functions create HTML fragments from normalized data.
 */

import { encodeHtml } from '@common/htmlEncoding.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';
import { stringifyForDisplay } from './normalizers.js';
import {
  INPUT_COMPACT_ENTRIES_THRESHOLD,
  COMPACT_VALUE_MAX_LENGTH,
} from './constants.js';
import {
  highlightCode,
  shouldHighlight,
  detectLanguageFromPath,
} from './syntaxHighlighter.js';

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
 * Wrap text in a pre/code element with syntax highlighting.
 * Falls back to plain pre if highlighting is not applicable.
 * @param {string} text - Text to wrap
 * @param {string} [className] - Optional CSS class for the pre element
 * @param {object} [options] - Highlighting options
 * @param {string} [options.language] - Language hint for highlighting
 * @param {string} [options.filePath] - File path for extension-based detection
 * @returns {string} HTML string with syntax highlighting
 */
export const wrapInHighlightedPre = (text, className = '', options = {}) => {
  if (!text) {
    return wrapInPre('', className);
  }

  const { language, filePath } = options;

  // Try to detect language from file path first (most reliable)
  const langFromPath = filePath ? detectLanguageFromPath(filePath) : null;
  const langHint = language || langFromPath;

  // Check if highlighting is appropriate for this content
  if (!shouldHighlight(text) && !langHint) {
    return wrapInPre(text, className);
  }

  const { html, language: detectedLang } = highlightCode(text, langHint);

  // If no language was detected, fall back to plain pre
  if (!detectedLang) {
    return wrapInPre(text, className);
  }

  // Build class string: include both original class and hljs language class
  const classes = ['hljs', className, `language-${detectedLang}`]
    .filter(Boolean)
    .join(' ');

  // Note: highlightCode returns pre-escaped HTML, so we don't encode again
  return `<pre class="${classes}"><code>${html}</code></pre>`;
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
 * Build edited files section for tool use display
 * @param {Array} files - Array of file info objects with path, name, linesAdded, linesRemoved
 * @returns {string} HTML string for edited files section
 */
export const buildEditedFilesSection = (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    return '';
  }

  const items = files
    .map((file) => {
      const pathEscaped = encodeHtml(file.path);
      const nameEscaped = encodeHtml(file.name);
      const stats = buildLineStats(file.linesAdded, file.linesRemoved);

      return `<li class="detail-item edited-file-item" title="${pathEscaped}">
        <i class="codicon codicon-file"></i>
        <span class="file-link clickable-link" data-file="${pathEscaped}">${nameEscaped}</span>
        ${stats}
      </li>`;
    })
    .join('');

  const summary =
    files.length === 1 ? '1 file edited' : `${files.length} files edited`;

  return `
    <div class="tool-files-section">
      <span class="tool-files-summary">${summary}</span>
      <ul class="detail-list edited-files-list">${items}</ul>
    </div>
  `;
};

/**
 * Build line statistics display (+X/-Y)
 * @param {number|undefined} added - Lines added
 * @param {number|undefined} removed - Lines removed
 * @returns {string} HTML string for line stats
 */
const buildLineStats = (added, removed) => {
  const hasAdded = typeof added === 'number' && added > 0;
  const hasRemoved = typeof removed === 'number' && removed > 0;

  if (!hasAdded && !hasRemoved) {
    return '';
  }

  const parts = [];
  if (hasAdded) {
    parts.push(`<span class="line-stat line-stat-added">+${added}</span>`);
  }
  if (hasRemoved) {
    parts.push(`<span class="line-stat line-stat-removed">-${removed}</span>`);
  }

  return `<span class="line-stats">${parts.join(' ')}</span>`;
};

/**
 * Build compact input display for tool parameters.
 * Shows key=value pairs inline for small inputs, falls back to YAML for larger ones.
 * @param {*} input - Input value (object or string)
 * @returns {string} HTML string for compact input
 */
export const buildCompactInput = (input) => {
  if (input === undefined || input === null) {
    return '';
  }

  // Handle string inputs directly
  if (typeof input === 'string') {
    return wrapInPre(input);
  }

  // Handle object inputs - show key=value pairs inline when possible
  if (typeof input === 'object') {
    const entries = Object.entries(input);
    if (entries.length <= INPUT_COMPACT_ENTRIES_THRESHOLD) {
      const compact = entries
        .map(([k, v]) => {
          const valStr =
            typeof v === 'string'
              ? v.length > COMPACT_VALUE_MAX_LENGTH
                ? v.slice(0, COMPACT_VALUE_MAX_LENGTH - 3) + '...'
                : v
              : JSON.stringify(v);
          return `<span class="input-param"><span class="input-key">${encodeHtml(k)}</span>: ${encodeHtml(valStr)}</span>`;
        })
        .join(' · ');

      return `<div class="compact-input">${compact}</div>`;
    }
  }

  // Fall back to YAML display
  const yaml = stringifyForDisplay(input);
  return wrapInPre(yaml);
};


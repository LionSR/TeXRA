/**
 * HTML generation utilities for progress view formatters.
 * These functions create HTML fragments from normalized data.
 */

import { encodeHtml } from '@common/htmlEncoding.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';
import { TOOL_ICON_MAP } from './constants.js';

/**
 * Build a tool-use section HTML block
 * @param {string} label - The section label (e.g., "Input:", "Output:")
 * @param {string} content - The HTML content for the section
 * @returns {string} HTML string for the section
 */
export function buildToolUseSection(label, content) {
  return `
  <div class="tool-use-section">
    <div class="tool-use-subsection">
      <span class="tool-use-sublabel">${label}</span>
      ${content}
    </div>
  </div>
`;
}

/**
 * Wrap text in a pre element with optional class
 * @param {string} text - Text to wrap (will be HTML encoded)
 * @param {string} [className] - Optional CSS class
 * @returns {string} HTML string
 */
export function wrapInPre(text, className = '') {
  const classAttr = className ? ` class="${className}"` : '';
  return `<pre${classAttr}>${encodeHtml(text)}</pre>`;
}

/**
 * Set common dataset attributes on an element
 * @param {HTMLElement} element - The element to modify
 * @param {{logId?: string, groupId?: string, timestamp?: string}} data - Dataset values
 */
export function setElementDataset(element, { logId, groupId, timestamp }) {
  if (logId) element.dataset.logId = logId;
  if (groupId) element.dataset.groupId = groupId;
  if (timestamp) element.dataset.fullTimestamp = timestamp;
}

/**
 * Initialize toggle icon on a collapsible element
 * @param {HTMLElement} element - Element containing toggle icon
 * @param {boolean} [expanded=false] - Whether the element is expanded
 */
export function initToggleIcon(element, expanded = false) {
  const toggleIcon = element.querySelector('.toggle-icon');
  if (toggleIcon) {
    toggleIcon.className = `${
      expanded ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS
    } toggle-icon`;
  }
}

/**
 * Build rendered HTML for file list
 * @param {Array} files - Array of normalized file entries
 * @returns {{items: string, summary: string}|null} Rendered items and summary
 */
export function buildFileListRender(files) {
  if (!Array.isArray(files)) return null;

  const items = files
    .map((file) => {
      const icon = file.ok ? 'codicon-check' : 'codicon-warning';
      const escaped = encodeHtml(file.filePath);
      const fileNameEscaped = encodeHtml(file.fileName);

      const metaParts = [];
      if (file.varName) {
        metaParts.push(
          `<span class="file-var">[${encodeHtml(file.varName)}]</span>`,
        );
      }
      if (file.source && file.source !== 'unknown') {
        const sourceText = file.internal
          ? `${encodeHtml(file.sourceDisplay)}, internal`
          : encodeHtml(file.sourceDisplay);
        metaParts.push(`<span class="file-source">(${sourceText})</span>`);
      }

      return `<li class="detail-item" title="${escaped}"><i class="codicon ${icon}"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span> ${metaParts.join(' ')}</li>`;
    })
    .join('');

  const loadedFiles = files.filter((file) => file.ok).length;
  const failedFiles = files.length - loadedFiles;
  const failedSuffix = failedFiles > 0 ? `, ${failedFiles} not found` : '';
  const summary = `Files (${loadedFiles}/${files.length} loaded${failedSuffix})`;

  return { items, summary };
}

/**
 * Build file link HTML element
 * @param {string} filePath - Absolute file path
 * @param {string} displayName - Display name for the link
 * @returns {string} HTML string for the file link
 */
export function buildFileLink(filePath, displayName) {
  if (!filePath) {
    return `<span>${encodeHtml(displayName)}</span>`;
  }
  return `<span class="file-link clickable-link" data-file="${encodeHtml(filePath)}">${encodeHtml(displayName)}</span>`;
}

/**
 * Build detail list item with icon
 * @param {string} iconClass - Codicon class (e.g., 'codicon-check')
 * @param {string} content - Inner HTML content
 * @param {object} [options] - Optional attributes
 * @param {string} [options.title] - Title attribute
 * @param {string} [options.runId] - data-run-id attribute
 * @returns {string} HTML string for list item
 */
export function buildDetailItem(iconClass, content, options = {}) {
  const titleAttr = options.title
    ? ` title="${encodeHtml(options.title)}"`
    : '';
  const runAttr = options.runId
    ? ` data-run-id="${encodeHtml(options.runId)}"`
    : '';
  return `<li class="detail-item"${runAttr}><i class="codicon ${iconClass}"${titleAttr}></i> ${content}</li>`;
}

/**
 * Get appropriate icon class for a tool
 * @param {string} toolName - Name of the tool
 * @param {boolean} isError - Whether the tool execution errored
 * @returns {string} Codicon class name
 */
export function getToolIconClass(toolName, isError = false) {
  if (isError) return 'codicon-error';
  return TOOL_ICON_MAP[toolName] || 'codicon-wrench';
}

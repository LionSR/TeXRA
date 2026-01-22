/**
 * HTML generation utilities for progress view formatters.
 * These functions create HTML fragments from normalized data.
 */

import hljs from 'highlight.js';
import { encodeHtml } from '@common/htmlEncoding.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';
import {
  TOOL_ICON_MAP,
  DIFF_DETECTION_LINE_LIMIT,
  DIFF_MARKER_THRESHOLD,
} from './constants.js';
import { generateInlineDiff } from './wordDiff.js';

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

// Diff line prefix patterns
// IMPORTANT: Longer prefixes (+++, ---) must appear before shorter ones (+, -)
// to ensure correct matching priority in getDiffLineClass
const DIFF_LINE_PATTERNS = [
  { prefix: '@@', className: 'diff-hunk' },
  { prefix: '+++', className: null }, // Header, not highlighted
  { prefix: '---', className: null }, // Header, not highlighted
  { prefix: '+', className: 'diff-add' },
  { prefix: '-', className: 'diff-remove' },
];

/**
 * Get diff line class based on line content
 * @param {string} line - Line to check
 * @returns {string|null} CSS class or null if not a diff line
 */
function getDiffLineClass(line) {
  for (const { prefix, className } of DIFF_LINE_PATTERNS) {
    if (line.startsWith(prefix)) return className;
  }
  return null;
}

/**
 * Check if text appears to be diff output.
 * Examines first N lines for diff markers (@@, +++, ---).
 * @param {string} text - Text to check
 * @returns {boolean} True if text looks like diff output
 */
function isDiffContent(text) {
  const lines = text.split('\n').slice(0, DIFF_DETECTION_LINE_LIMIT);
  const diffMarkers = lines.filter(
    (line) =>
      line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---'),
  ).length;
  return diffMarkers >= DIFF_MARKER_THRESHOLD;
}

/**
 * Wrap text in a pre element with optional class and diff highlighting
 * @param {string} text - Text to wrap (will be HTML encoded)
 * @param {string} [className] - Optional CSS class
 * @returns {string} HTML string
 */
export function wrapInPre(text, className = '') {
  const classAttr = className ? ` class="${className}"` : '';

  // Apply diff highlighting if content looks like a diff
  if (!isDiffContent(text)) {
    return `<pre${classAttr}>${encodeHtml(text)}</pre>`;
  }

  const highlightedLines = text.split('\n').map((line) => {
    const diffClass = getDiffLineClass(line);
    const encoded = encodeHtml(line);
    return diffClass ? `<span class="${diffClass}">${encoded}</span>` : encoded;
  });

  return `<pre${classAttr}>${highlightedLines.join('\n')}</pre>`;
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
        const sourceDisplay = encodeHtml(file.sourceDisplay);
        const sourceText = file.internal
          ? `${sourceDisplay}, internal`
          : sourceDisplay;
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

// ============================================================================
// Syntax Highlighting
// ============================================================================

/** Human-readable labels for language badges */
const LANGUAGE_LABELS = {
  bash: 'Bash',
  json: 'JSON',
  yaml: 'YAML',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  plaintext: 'Text',
};

/**
 * Get display label for a language
 * @param {string} language - Language identifier
 * @returns {string} Human-readable label
 */
function getLanguageLabel(language) {
  return LANGUAGE_LABELS[language] || language || 'Text';
}

/**
 * Build a code block with optional syntax highlighting, language badge, and copy button.
 * Does NOT use auto-detection - requires explicit language or defaults to plaintext.
 *
 * @param {string} text - Code text to display
 * @param {object} [options] - Configuration options
 * @param {string} [options.language='plaintext'] - Language for syntax highlighting
 * @param {string} [options.className] - Additional CSS class for the pre element
 * @param {boolean} [options.showLanguage=false] - Show language badge
 * @param {boolean} [options.showCopy=false] - Show copy button
 * @returns {string} HTML string for the code block
 */
export function buildCodeBlock(text, options = {}) {
  const {
    language = 'plaintext',
    className = '',
    showLanguage = false,
    showCopy = false,
  } = options;

  const classes = ['code-block'].filter(Boolean).join(' ');
  const preClasses = ['hljs', className].filter(Boolean).join(' ');

  // Build code content with or without highlighting
  let codeContent;
  const isHighlightable = language && language !== 'plaintext';

  if (isHighlightable && hljs.getLanguage(language)) {
    try {
      const result = hljs.highlight(text, { language, ignoreIllegals: true });
      codeContent = result.value;
    } catch {
      codeContent = encodeHtml(text);
    }
  } else {
    codeContent = encodeHtml(text);
  }

  // Build header with optional badge and copy button
  const headerParts = [];
  if (showLanguage) {
    const label = getLanguageLabel(language);
    headerParts.push(
      `<span class="code-block-language">${encodeHtml(label)}</span>`,
    );
  }
  if (showCopy) {
    headerParts.push(
      `<button class="code-block-copy" title="Copy to clipboard"><i class="codicon codicon-copy"></i></button>`,
    );
  }

  const header =
    headerParts.length > 0
      ? `<div class="code-block-header">${headerParts.join('')}</div>`
      : '';

  return `<div class="${classes}" data-language="${encodeHtml(language)}">${header}<pre class="${preClasses}"><code>${codeContent}</code></pre></div>`;
}

// ============================================================================
// File Links with Line Numbers
// ============================================================================

/**
 * Build a file link with optional line number for VS Code navigation
 * @param {string} filePath - Absolute file path
 * @param {object} [options] - Options
 * @param {number} [options.startLine] - Starting line number (1-based)
 * @param {number} [options.endLine] - Ending line number (1-based)
 * @returns {string} HTML string for the file link
 */
export function buildFileLinkWithLines(filePath, options = {}) {
  if (!filePath) return '';

  const { startLine, endLine } = options;
  const fileName = filePath.split('/').pop() || filePath;

  // Build line info string (only if range explicitly provided)
  let lineInfo = '';
  if (startLine && endLine && startLine !== endLine) {
    lineInfo = `:${startLine}-${endLine}`;
  } else if (startLine) {
    lineInfo = `:${startLine}`;
  }

  const displayText = fileName + lineInfo;
  const lineAttr = startLine ? ` data-file-line="${startLine}"` : '';

  return `<span class="file-link clickable-link" data-file="${encodeHtml(filePath)}"${lineAttr}><i class="codicon codicon-file"></i> ${encodeHtml(displayText)}</span>`;
}

// ============================================================================
// Edit Diff Display (Inline Word-Level Diff)
// ============================================================================

/**
 * Build edit diff section showing old_string → new_string with inline highlighting.
 * Deleted text shown with red strikethrough, added text shown with green highlight.
 * @param {string} oldString - Original text being replaced
 * @param {string} newString - Replacement text
 * @returns {string} HTML for the diff display
 */
export function buildEditDiffSection(oldString, newString) {
  const diffHtml = generateInlineDiff(oldString, newString);
  return `<div class="edit-diff-container"><pre class="diff-inline-view">${diffHtml}</pre></div>`;
}

// Third-party imports
import MarkdownIt from 'markdown-it';
import markdownItKatex from '@vscode/markdown-it-katex';
import { encode as encodeHtml, decode as decodeHtml } from 'he';
// Local imports
import { katexMacros } from './katexMacros.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { STATUS } from './constants.js';
import { createFromTemplate } from '@common/templateUtils.js';

// Constants

export const EMOJI_BY_LEVEL = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

/**
 * Represents different task group hierarchy levels with associated behaviors
 */
export const TaskGroupLevel = {
  ROOT: {
    name: 'root',
    formatTime: (date) => {
      const datePart = date.toLocaleDateString('en-CA');
      const timePart = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      return `${datePart} ${timePart}`;
    },
    showTitle: false,
    headerOrder: 'time-first', // time → bullet → usage
    cssClass: 'top-level',
  },
  NESTED: {
    name: 'nested',
    formatTime: (date) =>
      date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    showTitle: true,
    headerOrder: 'usage-first', // usage → bullet → time
    cssClass: null,
  },
};

/**
 * Format token counts, displaying values in "k" units when exceeding 4096.
 * @param {number} tokens - Raw token count
 * @returns {string} Formatted token count
 */
export function formatTokens(tokens) {
  return tokens > 4096 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/**
 * Extracts timestamps from HTML messages.
 */
export class MessageTimestampExtractor {
  /**
   * Extract timestamp from a log line element
   * @param {HTMLElement} element - Log line element
   * @returns {string} Extracted timestamp
   */
  extract(element) {
    const logLine = element.classList.contains('log-line')
      ? element
      : element.querySelector('.log-line');
    if (logLine && logLine.dataset.fullTimestamp) {
      return logLine.dataset.fullTimestamp;
    }

    const text = logLine
      ? logLine.textContent || ''
      : element.textContent || '';
    const match = text.match(/\[(.*?)\]/);
    return match ? match[1] : '';
  }
}

/**
 * Handles log entry formatting with markdown support.
 */
export class LogEntryFormatter {
  constructor() {
    this._initializeMarkdown();
  }

  _initializeMarkdown() {
    this.md = new MarkdownIt({
      breaks: false,
      linkify: true,
      html: false,
    }).use(markdownItKatex, {
      throwOnError: false,
      errorColor: '#cc0000',
      macros: katexMacros,
    });
  }

  /**
   * Format timestamp consistently across all methods
   * @param {Date} date - Date object to format
   * @returns {{fullTimestamp: string, timeDisplay: string}} Formatted timestamps
   */
  _formatTimestamp(date) {
    const fullTimestamp = date.toISOString();
    const timeDisplay = date
      .toISOString()
      .split('T')[1]
      .replace('Z', '')
      .split('.')[0];
    return { fullTimestamp, timeDisplay };
  }

  /**
   * Process markdown content with LaTeX reference protection
   * @param {string} content - Raw content to process
   * @param {boolean} decode - Whether to decode HTML entities (default: true)
   * @returns {string} Processed markdown HTML
   */
  _processMarkdownContent(content, decode = true) {
    // Unescape HTML entities if requested
    if (decode) {
      content = decodeHtml(content);
    }

    // Pre-process LaTeX references to protect them from markdown parsing
    content = content.replace(/\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');
    content = content.replace(/\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@');
    content = content.replace(/\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');

    // Process content as markdown
    let parsedMarkdown = this.md.render(content);

    // Post-process to restore and style LaTeX references
    parsedMarkdown = this._restoreLatexReferences(parsedMarkdown);

    return parsedMarkdown;
  }

  /**
   * Helper function to create LaTeX reference HTML
   * @param {string} refType - The reference type (ref, cref, eqref)
   * @param {string} label - The label value
   * @returns {string} HTML for the clickable reference
   */
  _createLatexReferenceHtml(refType, label) {
    return `<span class="latex-ref clickable-link" data-label="${label}">\\${refType}{${label}}</span>`;
  }

  /**
   * Restore LaTeX references from placeholders to clickable elements
   * @param {string} content - Content with placeholder references
   * @returns {string} Content with clickable LaTeX references
   */
  _restoreLatexReferences(content) {
    return content
      .replace(/@@LATEX-REF:([^@]+)@@/g, (_, label) =>
        this._createLatexReferenceHtml('ref', label),
      )
      .replace(/@@LATEX-CREF:([^@]+)@@/g, (_, label) =>
        this._createLatexReferenceHtml('cref', label),
      )
      .replace(/@@LATEX-EQREF:([^@]+)@@/g, (_, label) =>
        this._createLatexReferenceHtml('eqref', label),
      );
  }

  /**
   * Format a log entry with Markdown rendering for special content
   * @param {Object} logMessage - The log message to format
   * @returns {string} Formatted HTML for the log message
   */
  format(logMessage) {
    const { id, text, level, timestamp, groupId, messageType, verbose, data } =
      logMessage;

    const emoji = EMOJI_BY_LEVEL[level] || '•';
    const date = new Date(timestamp);
    const { fullTimestamp, timeDisplay } = this._formatTimestamp(date);

    const element = createFromTemplate('logLineTemplate');
    if (!element) return document.createElement('div');
    element.dataset.logId = id;
    if (groupId) element.dataset.groupId = groupId;
    element.dataset.fullTimestamp = fullTimestamp;

    const timestampEl = element.querySelector('.timestamp');
    if (timestampEl) {
      timestampEl.title = fullTimestamp;
      timestampEl.textContent = `${emoji}${verbose ? ` [${timeDisplay}]` : ''}`;
    }

    const levelEl = element.querySelector('.level');
    if (levelEl) {
      if (verbose) {
        levelEl.className = `level-${level}`;
        levelEl.textContent = level.toUpperCase().padEnd(8);
      } else {
        levelEl.remove();
      }
    }

    const msgEl = element.querySelector('.message');
    if (msgEl) {
      msgEl.className = `message-${level}`;
      msgEl.textContent = text;
    }

    if (messageType === 'thinking' || messageType === 'scratchpad') {
      const label = messageType === 'thinking' ? 'Thinking' : 'Scratchpad';
      const special = this._formatSpecialContent(text, label, id);
      if (special) {
        return special;
      }
    }

    if (messageType === 'toolUse') {
      const tool = this._formatToolUse(text, id);
      if (tool) {
        return tool;
      }
    }

    if (messageType === 'modelResponse') {
      const model = this._formatModelResponse({
        id,
        groupId,
        timestamp,
        verbose,
        content: text,
        level,
      });
      if (model) {
        return model;
      }
    }

    if (messageType === 'fileList') {
      const list = this._formatFileList(text, data, id);
      if (list) {
        return list;
      }
    }

    if (messageType === 'missingOutputs') {
      const missing = this._formatMissingOutputs(text, data, id);
      if (missing) {
        return missing;
      }
    }

    if (messageType === 'latexdiff') {
      const diff = this._formatLatexdiff(text, data, id);
      if (diff) {
        return diff;
      }
    }

    if (messageType === 'statistics') {
      const stats = this._formatStatistics(text, data, id);
      if (stats) {
        return stats;
      }
    }

    return element;
  }

  _formatSpecialContent(content, contentType, logId) {
    try {
      const parsedMarkdown = this._processMarkdownContent(content);
      let element = createFromTemplate('specialDetailsTemplate');
      if (!element) element = document.createElement('div');

      const isThinking = contentType.includes('Thinking');
      const labelText = isThinking ? 'Thinking' : 'Scratchpad';
      const icon = isThinking ? 'codicon-lightbulb' : 'codicon-pencil';

      const toggleIcon = element.querySelector('.toggle-icon');
      if (toggleIcon)
        toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;

      const iconElem = element.querySelector('.icon');
      if (iconElem) iconElem.classList.add(icon);

      const labelElem = element.querySelector('.label');
      if (labelElem) labelElem.textContent = labelText;

      const contentElem = element.querySelector('.special-content');
      if (contentElem) {
        contentElem.innerHTML = parsedMarkdown;
        if (logId) contentElem.dataset.logId = logId;
      }

      return element;
    } catch (e) {
      console.error('Error parsing markdown:', e);
      return null;
    }
  }

  _formatToolUse(content, logId) {
    try {
      const element = createFromTemplate('toolUseTemplate');
      if (!element) return null;
      let formattedContent;
      try {
        // Try to parse as JSON first - don't decode HTML entities
        const parsed = JSON.parse(content);

        // Check if this is the new combined format
        if (parsed.tool && parsed.input && parsed.output) {
          // Format combined tool input/output
          const toolName = parsed.tool;
          const inputJson = JSON.stringify(parsed.input, null, 2);
          const outputJson = JSON.stringify(parsed.output, null, 2);

          formattedContent = `
            <div class="tool-use-section">
              <div class="tool-use-label">${toolName}</div>
              <div class="tool-use-subsection">
                <span class="tool-use-sublabel">Input:</span>
                <pre>${inputJson}</pre>
              </div>
            </div>
            <hr class="tool-use-separator">
            <div class="tool-use-section">
              <div class="tool-use-subsection">
                <span class="tool-use-sublabel">Output:</span>
                <pre>${outputJson}</pre>
              </div>
            </div>`;
        } else {
          // Legacy format - just display as before
          formattedContent = `<pre>${JSON.stringify(parsed, null, 2)}</pre>`;
        }
      } catch {
        // If not valid JSON, just display as-is in a pre block
        // This preserves any HTML entities in error messages
        formattedContent = `<pre>${content}</pre>`;
      }

      const toggleIcon = element.querySelector('.toggle-icon');
      if (toggleIcon)
        toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;

      const contentElem = element.querySelector('.special-content');
      if (contentElem) {
        contentElem.innerHTML = formattedContent;
        if (logId) contentElem.dataset.logId = logId;
      }

      return element;
    } catch (e) {
      console.error('Error parsing tool use content:', e);
      return null;
    }
  }

  _formatModelResponse({ id, groupId, timestamp, verbose, content, level }) {
    try {
      const date = new Date(timestamp);
      const { fullTimestamp, timeDisplay } = this._formatTimestamp(date);
      const element = createFromTemplate('modelResponseTemplate');
      if (!element) return null;

      element.dataset.logId = id;
      if (groupId) element.dataset.groupId = groupId;
      element.dataset.fullTimestamp = fullTimestamp;

      const timeEl = element.querySelector('.timestamp');
      if (timeEl) {
        timeEl.title = fullTimestamp;
        timeEl.textContent = verbose ? `[${timeDisplay}]` : '';
      }

      const container = element.querySelector('.message-container');
      if (container) container.classList.add(`message-${level}`);

      const contentEl = element.querySelector('.model-response-content');
      if (contentEl)
        contentEl.innerHTML = this._processMarkdownContent(content);

      return element;
    } catch (e) {
      console.error('Error parsing model response:', e);
      return null;
    }
  }

  _formatFileList(content, data, logId) {
    try {
      const element = createFromTemplate('fileListDetailsTemplate');
      if (!element) return null;
      const contentElem = element.querySelector('.file-list-content');
      const summaryElem = element.querySelector('.summary-text');
      const toggleIcon = element.querySelector('.toggle-icon');
      if (toggleIcon)
        toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;

      const parsed = data ?? JSON.parse(decodeHtml(content));

      if (!Array.isArray(parsed)) {
        console.warn('Missing structured data for file list log entry');
        return null;
      }

      // Group files by source for better organization
      const filesBySource = {};
      parsed.forEach((f) => {
        const source = f.source || 'unknown';
        if (!filesBySource[source]) {
          filesBySource[source] = [];
        }
        filesBySource[source].push(f);
      });

      let items = '';
      Object.entries(filesBySource).forEach(([source, files]) => {
        files.forEach((f) => {
          const icon = f.ok ? 'codicon-check' : 'codicon-warning';
          const filePath = String(f.path ?? '');
          const escaped = encodeHtml(filePath);

          // Extract just the filename for display
          const fileName = filePath.split('/').pop() || filePath;
          const fileNameEscaped = encodeHtml(fileName);

          // Build metadata string
          let metadata = '';
          if (f.varName) {
            metadata += `<span class="file-var">[${f.varName}]</span>`;
          }
          if (source && source !== 'unknown') {
            // Simplify source display
            const sourceDisplay = source
              .replace('requiredFiles', 'required')
              .replace('Pattern ', '')
              .replace(/'/g, '');
            if (f.internal) {
              metadata += ` <span class="file-source">(${sourceDisplay}, internal)</span>`;
            } else {
              metadata += ` <span class="file-source">(${sourceDisplay})</span>`;
            }
          }

          items += `<li title="${escaped}"><i class="codicon ${icon}"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span> ${metadata}</li>`;
        });
      });

      const totalFiles = parsed.length;
      const loadedFiles = parsed.filter((f) => f.ok).length;
      const failedFiles = totalFiles - loadedFiles;

      let summary = `Files (${loadedFiles}/${totalFiles} loaded`;
      if (failedFiles > 0) {
        summary += `, ${failedFiles} not found`;
      }
      summary += ')';

      if (summaryElem) summaryElem.textContent = summary;
      if (contentElem) {
        contentElem.innerHTML = items;
        if (logId) contentElem.dataset.logId = logId;
      }

      return element;
    } catch (e) {
      console.error('Error parsing file list:', e);
      return null;
    }
  }

  _formatMissingOutputs(content, data, logId) {
    try {
      const element = createFromTemplate('missingOutputsDetailsTemplate');
      if (!element) return null;
      const contentElem = element.querySelector('.file-list-content');
      const summaryElem = element.querySelector('.summary-text');
      const toggleIcon = element.querySelector('.toggle-icon');
      if (toggleIcon)
        toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;

      const parsed = data ?? JSON.parse(decodeHtml(content));

      // Handle both old format (array) and new format (object with missing, xmlFile, documentTag)
      let missingFiles = [];
      let xmlFile = null;
      let documentTag = null;

      if (Array.isArray(parsed)) {
        // Old format: just an array of missing files
        missingFiles = parsed;
      } else if (parsed && typeof parsed === 'object') {
        // New format: object with missing files, XML file, and optional document tag
        missingFiles = parsed.missing || [];
        xmlFile = parsed.xmlFile;
        documentTag = parsed.documentTag;
      } else {
        console.warn('Missing structured data for missing outputs log entry');
        return null;
      }

      const items = missingFiles
        .map((f) => {
          const filePath = String(f);
          const escaped = encodeHtml(filePath);
          const fileName = filePath.split('/').pop() || filePath;
          const fileNameEscaped = encodeHtml(fileName);
          return `<li title="${escaped}"><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span></li>`;
        })
        .join('');

      // Add XML file link if available
      let xmlLink = '';
      if (xmlFile) {
        const xmlEscaped = encodeHtml(xmlFile);
        const xmlFileName = xmlFile.split('/').pop() || xmlFile;
        const xmlFileNameEscaped = encodeHtml(xmlFileName);
        const tagInfo = documentTag
          ? `<span class="document-tag">(Expected &lt;${encodeHtml(documentTag)}&gt; block)</span>`
          : '';
        xmlLink = `<div class="xml-link-container">
          <i class="codicon codicon-file-code"></i>
          <span>Open XML to check tag consistency:</span>
          <span class="file-link clickable-link" data-file="${xmlEscaped}">${xmlFileNameEscaped}</span>
          ${tagInfo}
        </div>`;
      }

      if (missingFiles.length === 0 && xmlFile) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = xmlLink;
        return wrapper.firstElementChild;
      }

      const summary = `Missing outputs (${missingFiles.length})`;

      if (summaryElem) summaryElem.textContent = summary;
      if (contentElem) {
        contentElem.innerHTML = items;
        if (logId) contentElem.dataset.logId = logId;
      }
      if (xmlLink && element) {
        const div = document.createElement('div');
        div.innerHTML = xmlLink;
        element.appendChild(div.firstElementChild);
      }

      return element;
    } catch (e) {
      console.error('Error parsing missing outputs:', e);
      return null;
    }
  }

  _formatLatexdiff(content, data, logId) {
    try {
      const element = createFromTemplate('latexdiffDetailsTemplate');
      if (!element) return null;
      const contentElem = element.querySelector('.latexdiff-content');
      const summaryElem = element.querySelector('.summary-text');
      const toggleIcon = element.querySelector('.toggle-icon');
      if (toggleIcon)
        toggleIcon.className = `${CHEVRON_DOWN_CLASS} toggle-icon`;

      const parsed = data ?? JSON.parse(decodeHtml(content));
      const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : [];

      if (entries.length === 0) {
        return null;
      }

      let items = '';
      entries.forEach((d) => {
        const basePath = String(d.base ?? '');
        const revisedPath = String(d.revised ?? '');
        const outputPath = String(d.output ?? '');
        const msg = d.message ? String(d.message) : '';

        const baseEsc = encodeHtml(basePath);
        const revisedEsc = encodeHtml(revisedPath);
        const outputEsc = encodeHtml(outputPath);

        const baseName = basePath.split('/').pop() || basePath;
        const revisedName = revisedPath.split('/').pop() || revisedPath;

        let icon = 'codicon-question';
        if (d.status === 'success') {
          icon = 'codicon-check';
        } else if (d.status === 'error') {
          icon = 'codicon-error';
        }

        const titleAttr = msg ? ` title="${encodeHtml(msg)}"` : '';

        items += `<li><i class="codicon ${icon}"${titleAttr}></i> <span class="file-link clickable-link" data-file="${baseEsc}">${encodeHtml(
          baseName,
        )}</span> <span class="arrow">&rarr;</span> <span class="file-link clickable-link" data-file="${revisedEsc}">${encodeHtml(
          revisedName,
        )}</span> (<span class="file-link clickable-link" data-file="${outputEsc}">diff</span>)</li>`;
      });

      const summary =
        entries.length === 1
          ? 'Latexdiff result'
          : `Latexdiff results (${entries.length})`;

      if (summaryElem) summaryElem.textContent = summary;
      if (contentElem) {
        contentElem.innerHTML = items;
        if (logId) contentElem.dataset.logId = logId;
      }

      return element;
    } catch (e) {
      console.error('Error parsing latexdiff entry:', e);
      return null;
    }
  }

  _formatStatistics(content, data, logId) {
    try {
      const element = createFromTemplate('statisticsDetailsTemplate');
      if (!element) return null;
      const contentElem = element.querySelector('.statistics-content');
      const toggleIcon = element.querySelector('.toggle-icon');
      if (toggleIcon)
        toggleIcon.className = `${CHEVRON_DOWN_CLASS} toggle-icon`;
      const parsed = data;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const items = [];
      const pushItem = (icon, label, value, suffix = '') => {
        items.push(
          `<span class="stat-item" title="${label}"><i class="codicon ${icon}"></i> ${value}${suffix}</span>`,
        );
      };

      if (parsed.inputTokens !== undefined) {
        pushItem(
          'codicon-arrow-up',
          'Input tokens',
          formatTokens(parsed.inputTokens),
        );
      }
      if (parsed.outputTokens !== undefined) {
        pushItem(
          'codicon-arrow-down',
          'Output tokens',
          formatTokens(parsed.outputTokens),
        );
      }
      if (parsed.cacheReadInputTokens !== undefined) {
        pushItem(
          'codicon-history',
          'Cache hits',
          formatTokens(parsed.cacheReadInputTokens),
        );
      }
      if (parsed.cacheCreationInputTokens !== undefined) {
        pushItem(
          'codicon-save',
          'Cache writes',
          formatTokens(parsed.cacheCreationInputTokens),
        );
      }
      if (parsed.percentageCached !== undefined) {
        pushItem(
          'codicon-graph-line',
          'Cached %',
          `${parsed.percentageCached.toFixed(2)}%`,
        );
      }
      if (parsed.reasoningTokens !== undefined) {
        pushItem(
          'codicon-comment-discussion',
          'Reasoning tokens',
          formatTokens(parsed.reasoningTokens),
        );
      }
      if (parsed.toolUseTokens !== undefined) {
        pushItem(
          'codicon-tools',
          'Tool tokens',
          formatTokens(parsed.toolUseTokens),
        );
      }
      if (parsed.elapsedTime !== undefined) {
        pushItem('codicon-clock', 'Elapsed time', parsed.elapsedTime, 's');
      }
      if (parsed.cost !== undefined) {
        pushItem('codicon-rocket', 'Cost', `$${parsed.cost.toFixed(3)}`);
      }

      if (contentElem) {
        contentElem.innerHTML = items.join('');
        if (logId) contentElem.dataset.logId = logId;
      }

      return element;
    } catch (e) {
      console.error('Error parsing statistics:', e);
      return null;
    }
  }
}

/**
 * Formats task group headers.
 */
export class TaskGroupHeaderFormatter {
  /**
   * Create a group header element
   * @param {Object} group - Task group data
   * @returns {HTMLElement} Header element
   */
  create(group) {
    const startDate = new Date(group.startTime);
    const level = this._getGroupLevel(group);
    const formattedStartTime = level.formatTime(startDate);

    const header = createFromTemplate('groupHeaderTemplate');
    if (!header) return document.createElement('summary');

    header.id = `group-header-${group.id}`;
    header.className = this._getHeaderClass(group, level);

    const statusIconElem = header.querySelector('.group-status-icon');
    if (statusIconElem) {
      statusIconElem.innerHTML = this._getStatusIcon(group.status);
    }

    const titleElem = header.querySelector('.group-title');
    if (titleElem) {
      if (level.showTitle) {
        titleElem.textContent = group.name;
      } else {
        titleElem.remove();
      }
    }

    const startTimeElem = header.querySelector('.group-start-time');
    if (startTimeElem) {
      startTimeElem.dataset.start = String(group.startTime);
      startTimeElem.innerHTML = `<i class="codicon codicon-clock"></i> ${formattedStartTime}`;
    }

    const durationElem = header.querySelector('.group-duration');
    if (durationElem) {
      if (group.endTime) {
        const durationMs = group.endTime - group.startTime;
        durationElem.textContent = this._formatDuration(durationMs);
      } else {
        durationElem.remove();
      }
    }

    return header;
  }

  _getGroupLevel(group) {
    return group.parentGroupId ? TaskGroupLevel.NESTED : TaskGroupLevel.ROOT;
  }

  _getHeaderClass(group, level) {
    const classes = ['log-group-header', group.status];
    if (level.cssClass) {
      classes.push(level.cssClass);
    }
    return classes.join(' ');
  }

  _getStatusIcon(status) {
    switch (status) {
      case STATUS.RUNNING:
        return '<i class="codicon codicon-sync spin"></i>';
      case STATUS.ERROR:
        return '<i class="codicon codicon-error"></i>';
      case STATUS.STOPPED:
        return '<i class="codicon codicon-check"></i>';
      default:
        return '<i class="codicon codicon-circle-outline"></i>';
    }
  }

  _formatDuration(durationMs) {
    // Handle edge cases
    if (durationMs < 0) return '0s';

    // For very short durations, show under a second
    if (durationMs < 1000) {
      return '<1s';
    }

    const seconds = Math.floor(durationMs / 1000) % 60;
    const minutes = Math.floor(durationMs / (1000 * 60));

    if (minutes === 0) {
      return `${seconds}sec`;
    } else if (seconds === 0) {
      return `${minutes}min`;
    } else {
      return `${minutes}min, ${seconds}sec`;
    }
  }
}

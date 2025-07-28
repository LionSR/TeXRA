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

// Constants
export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

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
   * Extract timestamp from HTML message
   * @param {string} message - HTML message containing timestamp
   * @returns {string} Extracted timestamp
   */
  extract(message) {
    // First try to extract the full timestamp from data-full-timestamp attribute
    const div = document.createElement('div');
    div.innerHTML = message;
    const logLine = div.querySelector('.log-line');
    if (logLine && logLine.dataset.fullTimestamp) {
      return logLine.dataset.fullTimestamp; // Return the full precise timestamp
    }

    // Fallback: extract from the message content using regex
    const match = message.match(/\[(.*?)\]/);
    return match ? match[1] : ''; // Extract timestamp or empty string
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
    const timeDisplay = date
      .toISOString()
      .split('T')[1]
      .replace('Z', '')
      .split('.')[0];
    const fullTimestamp = date.toISOString();

    const prefix = `<div class="log-line" data-log-id="${id}" ${
      groupId ? `data-group-id="${groupId}"` : ''
    } data-full-timestamp="${fullTimestamp}">`;
    const levelMarkup = verbose
      ? `<span class="level-${level}">${level.toUpperCase().padEnd(8)}</span> `
      : '';
    const htmlMessage =
      prefix +
      `<span class="timestamp" title="${fullTimestamp}">${emoji}${
        verbose ? ` [${timeDisplay}]` : ''
      }</span> ` +
      levelMarkup +
      `<span class="message-${level}">${text}</span>` +
      `</div>`;
    if (messageType === 'thinking' || messageType === 'scratchpad') {
      const label = messageType === 'thinking' ? 'Thinking' : 'Scratchpad';
      return this._formatSpecialContent(htmlMessage, text, label, id);
    }

    if (messageType === 'toolUse') {
      return this._formatToolUse(htmlMessage, text, id);
    }

    if (messageType === 'fileList') {
      return this._formatFileList(htmlMessage, text, data, id);
    }

    if (messageType === 'missingOutputs') {
      return this._formatMissingOutputs(htmlMessage, text, data, id);
    }

    if (messageType === 'latexdiff') {
      return this._formatLatexdiff(htmlMessage, text, data, id);
    }

    if (messageType === 'statistics') {
      return this._formatStatistics(htmlMessage, text, data, id);
    }

    return htmlMessage;
  }

  _formatSpecialContent(message, content, contentType, logId) {
    try {
      // Unescape HTML entities that were escaped during logging
      content = decodeHtml(content);

      // Pre-process LaTeX references to protect them from markdown parsing
      content = content.replace(/\\\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');
      content = content.replace(/\\\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@');
      content = content.replace(/\\\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');

      // Process content as markdown
      let parsedMarkdown = this.md.render(content);

      // Post-process to restore and style LaTeX references
      parsedMarkdown = this._restoreLatexReferences(parsedMarkdown);

      // Create enhanced content element with better formatting
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
      // Determine label and icon based on content type
      const isThinking = contentType.includes('Thinking');
      const labelText = isThinking ? 'Thinking' : 'Scratchpad';
      const icon = isThinking ? 'codicon-lightbulb' : 'codicon-pencil';

      return `<details class="special-details">
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon ${icon}"></i>
          <span>${labelText}</span>
        </summary>
        <div class="special-content"${idAttr}>${parsedMarkdown}</div>
      </details>`;
    } catch (e) {
      console.error('Error parsing markdown:', e);
      // Fallback to original content
      return message;
    }
  }

  _formatToolUse(message, content, logId) {
    try {
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
      content = decodeHtml(content);
      const parsedMarkdown = this.md.render(content);
      return `<details class="special-details">
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-wrench"></i>
          <span>Tool Use</span>
        </summary>
        <div class="special-content"${idAttr}>${parsedMarkdown}</div>
      </details>`;
    } catch (e) {
      console.error('Error parsing tool use content:', e);
      return message;
    }
  }

  _formatFileList(message, content, data, logId) {
    try {
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
      const parsed = data ?? JSON.parse(decodeHtml(content));

      if (!Array.isArray(parsed)) {
        console.warn('Missing structured data for file list log entry');
        return message;
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

      return `<details class="file-list-details">
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-list-tree"></i>
          <span>${summary}</span>
        </summary>
        <ul class="file-list-content"${idAttr}>${items}</ul>
      </details>`;
    } catch (e) {
      console.error('Error parsing file list:', e);
      return message;
    }
  }

  _formatMissingOutputs(message, content, data, logId) {
    try {
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
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
        return message;
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
        return xmlLink;
      }

      const summary = `Missing outputs (${missingFiles.length})`;

      return `<details class="file-list-details">
        <summary class="details-summary">
          <i class="${CHEVRON_RIGHT_CLASS} toggle-icon"></i>
          <i class="codicon codicon-warning"></i>
          <span>${summary}</span>
        </summary>
        <ul class="file-list-content"${idAttr}>${items}</ul>
        ${xmlLink}
      </details>`;
    } catch (e) {
      console.error('Error parsing missing outputs:', e);
      return message;
    }
  }

  _formatLatexdiff(message, content, data, logId) {
    try {
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
      const parsed = data ?? JSON.parse(decodeHtml(content));
      const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : [];

      if (entries.length === 0) {
        return message;
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

      return `<details class="latexdiff-details" open>
        <summary class="details-summary">
          <i class="${CHEVRON_DOWN_CLASS} toggle-icon"></i>
          <i class="codicon codicon-diff"></i>
          <span>${summary}</span>
        </summary>
        <ul class="latexdiff-content"${idAttr}>${items}</ul>
      </details>`;
    } catch (e) {
      console.error('Error parsing latexdiff entry:', e);
      return message;
    }
  }

  _formatStatistics(message, content, data, logId) {
    try {
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
      const parsed = data;
      if (!parsed || typeof parsed !== 'object') {
        return message;
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

      return `<details class="statistics-details" open>
        <summary class="details-summary">
          <i class="${CHEVRON_DOWN_CLASS} toggle-icon"></i>
          <i class="codicon codicon-dashboard"></i>
          <span>Statistics</span>
        </summary>
        <div class="statistics-content"${idAttr}>${items.join('')}</div>
      </details>`;
    } catch (e) {
      console.error('Error parsing statistics:', e);
      return message;
    }
  }
}

/**
 * Formats task group headers.
 */
export class TaskGroupHeaderFormatter {
  /**
   * Create a group header HTML
   * @param {Object} group - Task group data
   * @returns {string} HTML for group header
   */
  create(group) {
    const startDate = new Date(group.startTime);
    const level = this._getGroupLevel(group);
    const formattedStartTime = level.formatTime(startDate);

    let durationDisplay = '';
    if (group.endTime) {
      const durationMs = group.endTime - group.startTime;
      durationDisplay = `<span class="group-duration">${this._formatDuration(durationMs)}</span>`;
    }

    // Add indicator based on status
    const statusIcon = this._getStatusIcon(group.status);

    // Add usage information if available
    let usageDisplay = '';
    if (group.usage) {
      const { inputTokens = 0, outputTokens = 0, cost = 0 } = group.usage;
      usageDisplay =
        `<span class="group-usage"><i class="codicon codicon-arrow-up"></i> ${formatTokens(inputTokens)}, ` +
        `<i class="codicon codicon-arrow-down"></i> ${formatTokens(outputTokens)}, ` +
        `$${cost.toFixed(3)}</span>`;
    }

    const titleMarkup = level.showTitle
      ? `<span class="group-title">${group.name}</span>`
      : '';
    const headerClass = this._getHeaderClass(group, level);

    const timeMarkup = `
        <span class="group-time">
          <span class="group-start-time" data-start="${group.startTime}">
            <i class="codicon codicon-clock"></i> ${formattedStartTime}
          </span>
          ${durationDisplay}
        </span>`;

    const bulletMarkup = BULLET_MARKUP;

    const headerContents = this._formatHeaderElements(
      level,
      timeMarkup,
      usageDisplay,
      bulletMarkup,
    );

    return `
      <summary id="group-header-${group.id}" class="${headerClass}">
        <span class="group-status-icon">${statusIcon}</span>${titleMarkup}${headerContents}
      </summary>
    `;
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

  _formatHeaderElements(level, timeMarkup, usageDisplay, bulletMarkup) {
    if (level.headerOrder === 'time-first') {
      // For root level: time → bullet → usage
      return `${timeMarkup}${usageDisplay ? `${bulletMarkup}${usageDisplay}` : ''}`;
    } else {
      // For nested level: usage → bullet → time
      return `${usageDisplay ? `${usageDisplay}${bulletMarkup}` : ''}${timeMarkup}`;
    }
  }
}

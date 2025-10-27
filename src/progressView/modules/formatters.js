// Third-party imports
import markdownItKatex from '@vscode/markdown-it-katex';
/**
 * Formatters for log entries in the progress view.
 *
 * WHITESPACE HANDLING NOTE:
 * This module uses a hybrid approach for HTML generation:
 * - String-based HTML for format() to maintain precise whitespace control
 * - Template-based HTML for other methods where whitespace is less critical
 *
 * This is necessary because Prettier reformats HTML templates, introducing line breaks
 * that cause excessive whitespace in the rendered output. The two critical methods
 * that display plain text messages must use string concatenation to avoid this issue.
 */

// Third-party imports
import MarkdownIt from 'markdown-it';
import highlight from 'markdown-it-highlightjs';

// Local imports - progress view
import { STATUS } from './constants.js';

// Local imports
import { katexMacros } from './katexMacros.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { getBasename } from '@common/pathUtils.js';
import { encodeHtml, decodeHtml } from '@common/htmlEncoding.js';

export const EMOJI_BY_LEVEL = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

// DateTimeFormat options for consistent timestamp formatting
const DATETIME_FORMAT_OPTIONS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

const TIME_FORMAT_OPTIONS = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/**
 * Represents different task group hierarchy levels with associated behaviors
 */
export const TaskGroupLevel = {
  ROOT: {
    name: 'root',
    formatTime: (date) => {
      try {
        return new Intl.DateTimeFormat(
          undefined,
          DATETIME_FORMAT_OPTIONS,
        ).format(date);
      } catch (error) {
        const isoTimestamp = date.toISOString();
        const timePart =
          isoTimestamp.split('T')[1]?.split('.')[0] ?? isoTimestamp;
        return `${isoTimestamp.split('T')[0]} ${timePart}`;
      }
    },
    showTitle: false,
    headerOrder: 'time-first', // time → bullet → usage
    cssClass: 'top-level',
  },
  NESTED: {
    name: 'nested',
    formatTime: (date) => {
      try {
        return new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS).format(
          date,
        );
      } catch (error) {
        return (
          date.toISOString().split('T')[1]?.split('.')[0] ?? date.toISOString()
        );
      }
    },
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
    })
      .use(markdownItKatex, {
        throwOnError: false,
        errorColor: '#cc0000',
        macros: katexMacros,
      })
      .use(highlight);
  }

  /**
   * Format timestamp consistently across all methods
   * @param {Date} date - Date object to format
   * @returns {{fullTimestamp: string, timeDisplay: string}} Formatted timestamps
   */
  _formatTimestamp(date) {
    const isoTimestamp = date.toISOString();

    try {
      const timeDisplay = new Intl.DateTimeFormat(
        undefined,
        TIME_FORMAT_OPTIONS,
      ).format(date);
      const tooltipTimestamp = new Intl.DateTimeFormat(
        undefined,
        DATETIME_FORMAT_OPTIONS,
      ).format(date);

      return {
        fullTimestamp: isoTimestamp,
        timeDisplay,
        tooltipTimestamp,
      };
    } catch (error) {
      const timeDisplay =
        isoTimestamp.split('T')[1]?.split('.')[0] ?? isoTimestamp;
      return {
        fullTimestamp: isoTimestamp,
        timeDisplay,
        tooltipTimestamp: isoTimestamp,
      };
    }
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
   * Get the formatter for a specific message type
   * @private
   * @returns {Object} Map of message types to their formatters with error handling
   */
  _getFormatters() {
    return {
      thinking: (text, id, groupId, timestamp) =>
        this._safeFormat(
          () =>
            this._formatBannerContent(text, 'Thinking', id, groupId, timestamp),
          'thinking',
        ),
      scratchpad: (text, id, groupId, timestamp) =>
        this._safeFormat(
          () =>
            this._formatBannerContent(
              text,
              'Scratchpad',
              id,
              groupId,
              timestamp,
            ),
          'scratchpad',
        ),
      toolUse: (text, data, id, groupId, timestamp) =>
        this._safeFormat(
          () => this._formatToolUse(text, data, id, groupId, timestamp),
          'tool use',
        ),
      modelResponse: (params) =>
        this._safeFormat(() => this._formatModelResponse(params), 'Assistant'),
      fileList: (text, data, id) =>
        this._safeFormat(
          () => this._formatFileList(text, data, id),
          'file list',
        ),
      missingOutputs: (text, data, id) =>
        this._safeFormat(
          () => this._formatMissingOutputs(text, data, id),
          'missing outputs',
        ),
      latexdiff: (text, data, id) =>
        this._safeFormat(
          () => this._formatLatexdiff(text, data, id),
          'latexdiff',
        ),
      statistics: (text, data, id) =>
        this._safeFormat(
          () => this._formatStatistics(text, data, id),
          'statistics',
        ),
      userMessage: (text, id, timestamp) =>
        this._safeFormat(
          () => this._formatUserMessage(text, id, timestamp),
          'user message',
        ),
      progressStatus: (text, id, timestamp) =>
        this._safeFormat(
          () => this._formatProgressStatus(text, id, timestamp),
          'progress status',
        ),
    };
  }

  /**
   * Safely execute a formatting function with error handling
   * @private
   * @param {Function} formatter - The formatting function to execute
   * @param {string} errorContext - Context for error message (e.g., 'banner content', 'tool use')
   * @returns {*} Result of formatter or null if error
   */
  _safeFormat(formatter, errorContext) {
    try {
      return formatter();
    } catch (e) {
      console.error(`Error parsing ${errorContext}:`, e);
      return null;
    }
  }

  /**
   * Format a log entry with Markdown rendering for banner content
   * @param {Object} logMessage - The log message to format
   * @returns {HTMLElement} DOM element for the log message
   *
   * IMPORTANT: This method uses string-based HTML generation instead of templates
   * for the default log messages to maintain precise control over whitespace.
   * Prettier and other formatters will reformat HTML templates, introducing unwanted
   * line breaks and spaces that create visual issues in the output.
   * DO NOT convert this to use templates unless you have a solution for the
   * whitespace formatting issue.
   */
  format(logMessage) {
    const { id, text, level, timestamp, groupId, messageType, verbose, data } =
      logMessage;

    const emoji = EMOJI_BY_LEVEL[level] || '•';
    const date = new Date(timestamp);
    const { fullTimestamp, timeDisplay, tooltipTimestamp } =
      this._formatTimestamp(date);

    // Check if we have a custom formatter for this message type
    const formatters = this._getFormatters();
    const formatter = formatters[messageType];

    if (formatter) {
      let result;
      if (messageType === 'modelResponse') {
        // modelResponse needs the full parameter object
        result = formatter({
          id,
          groupId,
          timestamp,
          verbose,
          content: text,
          level,
        });
      } else if (messageType === 'thinking' || messageType === 'scratchpad') {
        // Pass identifiers so the formatter can apply grouping metadata
        // Note: timestamp here is numeric (from Date.now())
        result = formatter(text, id, groupId, timestamp);
      } else if (messageType === 'toolUse') {
        // Tool use needs both the rendered text and the structured payload
        result = formatter(text, data, id, groupId, timestamp);
      } else if (messageType === 'userMessage') {
        // User message needs text, id, and timestamp
        result = formatter(text, id, timestamp);
      } else if (messageType === 'progressStatus') {
        result = formatter(text, id, timestamp);
      } else {
        // File list, missing outputs, latexdiff, statistics need data
        result = formatter(text, data, id);
      }

      if (result) {
        return result;
      }
      if (
        messageType === 'thinking' ||
        messageType === 'scratchpad' ||
        messageType === 'modelResponse'
      ) {
        return null;
      }
    }

    // Default formatting for regular log messages
    const prefix = `<div class="log-line" data-log-id="${id}" ${
      groupId ? `data-group-id="${groupId}"` : ''
    } data-full-timestamp="${fullTimestamp}">`;
    const levelMarkup = verbose
      ? `<span class="level-${level}">${level.toUpperCase().padEnd(8)}</span> `
      : '';

    const htmlMessage =
      prefix +
      `<span class="timestamp" title="${tooltipTimestamp}">${emoji}${
        verbose ? ` [${timeDisplay}]` : ''
      }</span> ` +
      levelMarkup +
      `<span class="message-${level}">${text}</span>` +
      `</div>`;

    // Convert HTML string to DOM element
    const wrapper = document.createElement('div');
    wrapper.innerHTML = htmlMessage;
    return wrapper.firstElementChild;
  }

  _formatBannerContent(content, contentType, logId, groupId, timestamp) {
    if (!content || !content.trim()) return null;
    const decodedContent = decodeHtml(content);
    if (!decodedContent.trim()) {
      return null;
    }

    const parsedMarkdown = this._processMarkdownContent(decodedContent, false);
    const isThinking = contentType.includes('Thinking');
    const bannerEntry = this._createBannerEntry({
      logId,
      groupId,
      timestamp,
      iconClass: isThinking ? 'codicon-lightbulb' : 'codicon-pencil',
      labelText: isThinking ? 'Thinking' : 'Scratchpad',
      copyTitle: isThinking ? 'Copy thinking' : 'Copy scratchpad',
      contentClass: isThinking
        ? 'banner-content--thinking'
        : 'banner-content--scratchpad',
      open: false,
    });

    if (!bannerEntry || !bannerEntry.contentElem) {
      return bannerEntry ? bannerEntry.element : null;
    }

    bannerEntry.contentElem.dataset.rawContent = decodedContent;
    bannerEntry.contentElem.innerHTML = parsedMarkdown;

    return bannerEntry.element;
  }

  _formatToolUse(content, structuredData, logId, groupId, timestamp) {
    const element = createFromTemplate('toolUseTemplate');
    if (!element) return null;

    if (logId) element.dataset.logId = logId;
    if (groupId) element.dataset.groupId = groupId;
    if (timestamp) element.dataset.fullTimestamp = timestamp;

    const headerLabel = element.querySelector('.tool-use-title');
    const iconElem = headerLabel ? headerLabel.previousElementSibling : null;
    if (headerLabel) headerLabel.textContent = 'Tool Use';
    if (iconElem) iconElem.className = 'codicon codicon-wrench';
    element.heading = 'Tool Use';
    element.dataset.isOpen = element.hasAttribute('open') ? 'true' : 'false';
    element.classList.remove('tool-use-error');

    const contentElem = element.querySelector('.banner-content');
    if (!contentElem) {
      return element;
    }

    const MAX_PREVIEW_CHARS = 240;
    const makePreview = (value) => {
      if (!value) return '';
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (normalized.length <= MAX_PREVIEW_CHARS) {
        return normalized;
      }
      return `${normalized.slice(0, MAX_PREVIEW_CHARS - 1)}…`;
    };

    const rawContent =
      typeof content === 'string' && content.length > 0
        ? decodeHtml(content)
        : '';
    const hasStructuredData =
      structuredData &&
      typeof structuredData === 'object' &&
      !Array.isArray(structuredData);
    let parsed = hasStructuredData ? structuredData : null;

    if (!parsed && rawContent) {
      try {
        parsed = JSON.parse(rawContent);
      } catch (error) {
        parsed = null;
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (headerLabel) headerLabel.textContent = 'Tool Use (raw entry)';
      if (iconElem) iconElem.className = 'codicon codicon-wrench';
      element.classList.remove('tool-use-error');

      let fallbackContent = rawContent;
      if (!fallbackContent && structuredData !== undefined) {
        if (typeof structuredData === 'string') {
          fallbackContent = structuredData;
        } else {
          try {
            fallbackContent = JSON.stringify(structuredData, null, 2);
          } catch (error) {
            fallbackContent = String(structuredData);
          }
        }
      }

      contentElem.innerHTML = `
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Raw log:</span>
            <pre>${encodeHtml(fallbackContent || '')}</pre>
          </div>
        </div>
      `;

      return element;
    }

    const toolName =
      typeof parsed.tool === 'string'
        ? parsed.tool.trim()
        : typeof parsed.name === 'string'
          ? parsed.name.trim()
          : '';

    const outputCandidate =
      parsed.output &&
      typeof parsed.output === 'object' &&
      !Array.isArray(parsed.output)
        ? parsed.output
        : parsed.result &&
            typeof parsed.result === 'object' &&
            !Array.isArray(parsed.result)
          ? parsed.result
          : {};

    const summaryText =
      typeof outputCandidate.summary === 'string' &&
      outputCandidate.summary.trim()
        ? outputCandidate.summary.trim()
        : typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : '';

    const errorText =
      typeof outputCandidate.error === 'string'
        ? outputCandidate.error
        : typeof parsed.error === 'string'
          ? parsed.error
          : '';

    let outputText = '';
    if (typeof outputCandidate.output === 'string') {
      outputText = outputCandidate.output;
    } else if (typeof parsed.output === 'string') {
      outputText = parsed.output;
    }

    const isError = Boolean(
      (typeof outputCandidate.isError === 'boolean' &&
        outputCandidate.isError) ||
        (typeof parsed.isError === 'boolean' && parsed.isError) ||
        (typeof errorText === 'string' && errorText.trim().length > 0),
    );

    const headerSummary =
      summaryText || makePreview(errorText || outputText || '');

    const titlePrefix = isError ? 'Tool Error' : 'Tool Use';
    const titleBase = toolName ? `${titlePrefix}: ${toolName}` : titlePrefix;
    const titleText = headerSummary
      ? `${titleBase} — ${headerSummary}`
      : titleBase;

    if (headerLabel) headerLabel.textContent = titleText;
    if (iconElem) {
      iconElem.className = isError
        ? 'codicon codicon-error'
        : 'codicon codicon-wrench';
    }
    element.classList.toggle('tool-use-error', isError);

    const sections = [];

    if (parsed.input !== undefined) {
      const inputValue =
        typeof parsed.input === 'string'
          ? parsed.input
          : JSON.stringify(parsed.input, null, 2);
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Input:</span>
            <pre>${encodeHtml(inputValue)}</pre>
          </div>
        </div>
      `);
    }

    if (errorText) {
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Error:</span>
            <pre>${encodeHtml(errorText)}</pre>
          </div>
        </div>
      `);
    }

    if (outputText) {
      const encodedOutput = encodeHtml(outputText);
      if (!summaryText && outputText.length > MAX_PREVIEW_CHARS) {
        const preview = encodeHtml(
          `${outputText.slice(0, MAX_PREVIEW_CHARS).trimEnd()}…`,
        );
        sections.push(`
          <div class="tool-use-section">
            <div class="tool-use-subsection">
              <span class="tool-use-sublabel">Output:</span>
              <pre class="tool-output-preview">${preview}</pre>
              <details class="tool-output-details">
                <summary class="details-summary">Show full output</summary>
                <pre class="tool-output-full">${encodedOutput}</pre>
              </details>
            </div>
          </div>
        `);
      } else {
        sections.push(`
          <div class="tool-use-section">
            <div class="tool-use-subsection">
              <span class="tool-use-sublabel">Output:</span>
              <pre class="tool-output-full">${encodedOutput}</pre>
            </div>
          </div>
        `);
      }
    }

    if (outputCandidate && outputCandidate.diagnostics !== undefined) {
      const diagnosticsJson = JSON.stringify(
        outputCandidate.diagnostics,
        null,
        2,
      );
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Diagnostics:</span>
            <pre>${encodeHtml(diagnosticsJson)}</pre>
          </div>
        </div>
      `);
    }

    if (outputCandidate && typeof outputCandidate.system === 'string') {
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">System:</span>
            <pre>${encodeHtml(outputCandidate.system)}</pre>
          </div>
        </div>
      `);
    }

    if (outputCandidate && typeof outputCandidate.base64Image === 'string') {
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Image:</span>
            <pre>(base64 image omitted)</pre>
          </div>
        </div>
      `);
    }

    if (sections.length === 0) {
      const fallbackJson = (() => {
        try {
          return JSON.stringify(parsed, null, 2);
        } catch (error) {
          return rawContent;
        }
      })();
      contentElem.innerHTML = `<pre>${encodeHtml(fallbackJson || '')}</pre>`;
    } else {
      contentElem.innerHTML = sections.join('<hr class="tool-use-separator">');
    }

    return element;
  }

  /**
   * Format a model response with markdown rendering
   * @private
   * @param {Object} params - Response parameters
   * @returns {HTMLElement|null} DOM element for the model response
   */
  _formatModelResponse({ id, groupId, timestamp, verbose, content, level }) {
    if (!content) {
      return null;
    }

    const decodedContent = decodeHtml(content);
    if (!decodedContent.trim()) {
      return null;
    }

    const date = new Date(timestamp);
    const { fullTimestamp, timeDisplay, tooltipTimestamp } =
      this._formatTimestamp(date);

    const bannerEntry = this._createBannerEntry({
      logId: id,
      groupId,
      timestamp: fullTimestamp,
      iconClass: 'codicon-sparkle',
      labelText: 'Assistant',
      copyTitle: 'Copy model output',
      contentClass: 'banner-content--model',
      open: true,
    });

    if (!bannerEntry) {
      return null;
    }

    const { element, contentElem, summaryElem } = bannerEntry;

    if (summaryElem) {
      const timestampElem = summaryElem.querySelector('.timestamp');
      if (timestampElem) {
        timestampElem.title = tooltipTimestamp;
        const shouldShowTimestamp = Boolean(verbose);
        timestampElem.textContent = shouldShowTimestamp
          ? `[${timeDisplay}]`
          : '';
        timestampElem.toggleAttribute('hidden', !shouldShowTimestamp);
      }
    }

    if (contentElem) {
      contentElem.classList.add(`message-${level}`);
      contentElem.dataset.rawContent = decodedContent;
      contentElem.innerHTML = this._processMarkdownContent(
        decodedContent,
        false,
      );
    }

    return element;
  }

  _createBannerEntry({
    logId,
    groupId,
    timestamp,
    iconClass,
    labelText,
    copyTitle,
    contentClass,
    open = false,
    templateId = 'bannerDetailsTemplate',
  }) {
    const element = createFromTemplate(templateId);
    if (!element) return null;

    if (open) {
      element.setAttribute('open', '');
    } else {
      element.removeAttribute('open');
    }
    element.dataset.isOpen = open ? 'true' : 'false';

    if (logId) element.dataset.logId = logId;
    if (groupId) element.dataset.groupId = groupId;
    if (timestamp) element.dataset.fullTimestamp = timestamp;

    if (typeof labelText === 'string') {
      element.heading = labelText;
    } else {
      element.heading = '';
    }

    const iconElem = element.querySelector('.icon');
    if (iconElem) {
      iconElem.className = 'codicon icon';
      if (iconClass) {
        iconElem.classList.add(iconClass);
        iconElem.hidden = false;
      } else {
        iconElem.hidden = true;
      }
    }

    const copyButton = element.querySelector('.banner-content-copy');
    if (copyButton) {
      const defaultTitle =
        copyTitle ||
        (labelText ? `Copy ${labelText.toLowerCase()}` : 'Copy content');
      copyButton.dataset.defaultTitle = defaultTitle;
      copyButton.dataset.successTitle = 'Copied!';
      copyButton.setAttribute('title', defaultTitle);
      copyButton.setAttribute('aria-label', defaultTitle);
    }

    const contentElem = element.querySelector('.banner-content');
    if (contentElem && contentClass) {
      contentElem.classList.add(contentClass);
    }

    return {
      element,
      contentElem,
      copyButton,
      summaryElem: element.querySelector('.details-summary'),
    };
  }

  _formatFileList(content, data, logId) {
    const element = createFromTemplate('fileListDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.file-list-content');
    const summaryElem = element.querySelector('.summary-text');
    element.heading = 'Generated Files';
    element.dataset.isOpen = element.hasAttribute('open') ? 'true' : 'false';

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
        const fileName = getBasename(filePath);
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

        items += `<li class="detail-item" title="${escaped}"><i class="codicon ${icon}"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span> ${metadata}</li>`;
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
    else element.heading = summary;
    if (contentElem) {
      contentElem.innerHTML = items;
      if (logId) contentElem.dataset.logId = logId;
    }

    return element;
  }

  _formatMissingOutputs(content, data, logId) {
    const element = createFromTemplate('missingOutputsDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.file-list-content');
    const summaryElem = element.querySelector('.summary-text');
    element.heading = 'Missing Outputs';
    element.dataset.isOpen = element.hasAttribute('open') ? 'true' : 'false';

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
        const fileName = getBasename(filePath);
        const fileNameEscaped = encodeHtml(fileName);
        return `<li class="detail-item" title="${escaped}"><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span></li>`;
      })
      .join('');

    // Add XML file link if available
    let xmlLink = '';
    if (xmlFile) {
      const xmlEscaped = encodeHtml(xmlFile);
      const xmlFileName = getBasename(xmlFile);
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
      const element = wrapper.firstElementChild;
      if (!element) {
        console.error('Failed to create XML link element from HTML:', xmlLink);
        return null;
      }
      return element;
    }

    const summary = `Missing outputs (${missingFiles.length})`;

    if (summaryElem) summaryElem.textContent = summary;
    else element.heading = summary;
    if (contentElem) {
      contentElem.innerHTML = items;
      if (logId) contentElem.dataset.logId = logId;
    }
    if (xmlLink && element) {
      const div = document.createElement('div');
      div.innerHTML = xmlLink;
      const xmlElement = div.firstElementChild;
      if (xmlElement) {
        element.appendChild(xmlElement);
      } else {
        console.error('Failed to create XML link element from HTML:', xmlLink);
      }
    }

    return element;
  }

  _formatLatexdiff(content, data, logId) {
    const element = createFromTemplate('latexdiffDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.latexdiff-content');
    const summaryElem = element.querySelector('.summary-text');
    element.dataset.isOpen = element.hasAttribute('open') ? 'true' : 'false';

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

      const baseName = getBasename(basePath);
      const revisedName = getBasename(revisedPath);

      let icon = 'codicon-question';
      if (d.status === 'success') {
        icon = 'codicon-check';
      } else if (d.status === 'error') {
        icon = 'codicon-error';
      }

      const titleAttr = msg ? ` title="${encodeHtml(msg)}"` : '';

      items += `<li class="detail-item"><i class="codicon ${icon}"${titleAttr}></i> <span class="file-link clickable-link" data-file="${baseEsc}">${encodeHtml(
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
    element.heading = summary;
    if (contentElem) {
      contentElem.innerHTML = items;
      if (logId) contentElem.dataset.logId = logId;
    }

    return element;
  }

  _formatStatistics(content, data, logId) {
    // Note: content parameter kept for consistency with other formatters but not used
    const element = createFromTemplate('statisticsDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.statistics-content');
    element.heading = 'Statistics';
    element.dataset.isOpen = element.hasAttribute('open') ? 'true' : 'false';
    const parsed = data;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const items = [];
    const pushItem = (icon, label, value, suffix = '') => {
      items.push(
        `<span class="stat-item detail-item" title="${label}"><i class="codicon ${icon}"></i> ${value}${suffix}</span>`,
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
  }

  _formatProgressStatus(content, logId, timestamp) {
    const element = createFromTemplate('nativeStatusTemplate');
    if (!element) return null;

    const date = new Date(timestamp ?? Date.now());
    const { fullTimestamp, timeDisplay, tooltipTimestamp } =
      this._formatTimestamp(date);

    element.dataset.fullTimestamp = fullTimestamp;
    if (logId) {
      element.dataset.logId = logId;
    }

    const timeElem = element.querySelector('.native-status-time');
    if (timeElem) {
      timeElem.textContent = timeDisplay;
      timeElem.title = tooltipTimestamp;
    }

    const textElem = element.querySelector('.native-status-text');
    if (textElem) {
      const decodedContent =
        typeof content === 'string' ? decodeHtml(content) : '';
      textElem.textContent = decodedContent;
    }

    return element;
  }

  _formatUserMessage(content, logId, timestamp) {
    const element = createFromTemplate('userMessageTemplate');
    if (!element) return null;

    const date = new Date(timestamp);
    const { fullTimestamp, timeDisplay, tooltipTimestamp } =
      this._formatTimestamp(date);

    const timestampElem = element.querySelector('.user-message-timestamp');
    if (timestampElem) {
      timestampElem.textContent = timeDisplay;
      timestampElem.title = tooltipTimestamp;
    }

    const contentElem = element.querySelector('.user-message-content');
    if (contentElem) {
      const decodedContent =
        typeof content === 'string' ? decodeHtml(content) : '';
      contentElem.textContent = decodedContent;
      if (logId) contentElem.dataset.logId = logId;
    }

    return element;
  }
}

/**
 * Formats task group headers.
 */
export class TaskGroupHeaderFormatter {
  /**
   * Create a group header element
   * @param {Object} group - Task group data
   * @returns {HTMLElement|null} Header element or null if template creation fails
   */
  create(group) {
    const startDate = new Date(group.startTime);
    const level = this._getGroupLevel(group);
    const formattedStartTime = level.formatTime(startDate);

    const header = createFromTemplate('groupHeaderTemplate');
    if (!header) return null;

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

    // Add usage information if available
    if (group.usage) {
      const { inputTokens = 0, outputTokens = 0, cost = 0 } = group.usage;
      const usageDisplay =
        `<span class="group-usage"><i class="codicon codicon-arrow-up"></i> ${formatTokens(inputTokens)}, ` +
        `<i class="codicon codicon-arrow-down"></i> ${formatTokens(outputTokens)}, ` +
        `$${cost.toFixed(3)}</span>`;

      const bulletMarkup =
        '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

      // Add usage and bullet based on level
      const timeSpan = header.querySelector('.group-time');
      if (timeSpan) {
        if (level.headerOrder === 'time-first') {
          // For root level: time → bullet → usage
          timeSpan.insertAdjacentHTML(
            'afterend',
            usageDisplay ? `${bulletMarkup}${usageDisplay}` : '',
          );
        } else {
          // For nested level: usage → bullet → time
          timeSpan.insertAdjacentHTML(
            'beforebegin',
            usageDisplay ? `${usageDisplay}${bulletMarkup}` : '',
          );
        }
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

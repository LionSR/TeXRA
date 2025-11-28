// Third-party imports
import yaml from 'yaml';
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
import { STREAM_STATUS, GROUP_DOM_IDS } from './constants.js';

// Local imports
import { katexMacros } from './katexMacros.js';
import { createFromTemplate } from '@common/templateUtils.js';
import {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';
import { getBasename } from '@common/pathUtils.js';
import { encodeHtml, decodeHtml } from '@common/htmlEncoding.js';

// Constants
export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

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

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, TIME_FORMAT_OPTIONS);
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(
  undefined,
  DATETIME_FORMAT_OPTIONS,
);

let markdownRenderer;

const stringifyForDisplay = (value) => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    const yamlString = yaml.stringify(value);
    return typeof yamlString === 'string' ? yamlString.trimEnd() : '';
  } catch (error) {
    return String(value);
  }
};

const getMarkdownRenderer = () => {
  if (!markdownRenderer) {
    markdownRenderer = new MarkdownIt({
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

  return markdownRenderer;
};

const tryParseJson = (text) => {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
};

const normalizeStructuredContent = (text, data) => {
  if (data !== undefined) {
    return {
      decodedText: '',
      structured: data,
    };
  }

  const decodedText = typeof text === 'string' ? decodeHtml(text) : '';
  return { decodedText, structured: tryParseJson(decodedText) };
};

const normalizeFileListEntries = (structured) => {
  if (!Array.isArray(structured)) {
    return null;
  }

  return structured.map((file) => {
    const rawPath = String(file?.path ?? '');
    const source = file?.source || 'unknown';
    const sourceDisplay =
      typeof file?.sourceDisplay === 'string' ? file.sourceDisplay : source;

    return {
      filePath: rawPath,
      fileName: getBasename(rawPath),
      ok: Boolean(file?.ok),
      source,
      sourceDisplay,
      internal: Boolean(file?.internal),
      varName: typeof file?.varName === 'string' ? file.varName : '',
    };
  });
};

const buildFileListRender = (files) => {
  if (!Array.isArray(files)) {
    return null;
  }

  const filesBySource = {};
  files.forEach((file) => {
    const source = file.source || 'unknown';
    if (!filesBySource[source]) {
      filesBySource[source] = [];
    }
    filesBySource[source].push(file);
  });

  let items = '';
  Object.entries(filesBySource).forEach(([source, groupedFiles]) => {
    groupedFiles.forEach((file) => {
      const icon = file.ok ? 'codicon-check' : 'codicon-warning';
      const escaped = encodeHtml(file.filePath);
      const fileNameEscaped = encodeHtml(file.fileName);

      let metadata = '';
      if (file.varName) {
        metadata += `<span class="file-var">[${file.varName}]</span>`;
      }
      if (source && source !== 'unknown') {
        if (file.internal) {
          metadata += ` <span class="file-source">(${file.sourceDisplay}, internal)</span>`;
        } else {
          metadata += ` <span class="file-source">(${file.sourceDisplay})</span>`;
        }
      }

      items += `<li class="detail-item" title="${escaped}"><i class="codicon ${icon}"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span> ${metadata}</li>`;
    });
  });

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

const normalizeMissingOutputsPayload = (structured) => {
  if (!structured) return null;

  return {
    missing: Array.isArray(structured.missing) ? structured.missing : [],
    xmlFile:
      typeof structured.xmlFile === 'string' && structured.xmlFile
        ? structured.xmlFile
        : null,
    documentTag:
      typeof structured.documentTag === 'string' && structured.documentTag
        ? structured.documentTag
        : null,
  };
};

const normalizeLatexdiffEntries = (structured) => {
  if (!Array.isArray(structured)) return null;
  return structured;
};

const normalizeToolUseLog = (structured) => {
  if (
    !structured ||
    typeof structured !== 'object' ||
    Array.isArray(structured)
  ) {
    return null;
  }

  const parsed = structured;
  const outputDetails =
    parsed.output && typeof parsed.output === 'object' && parsed.output !== null
      ? parsed.output
      : {};

  const summaryText =
    (typeof parsed.summary === 'string' && parsed.summary.trim()) ||
    (typeof outputDetails.summary === 'string' &&
      outputDetails.summary.trim()) ||
    '';

  const errorText =
    (typeof parsed.error === 'string' && parsed.error.trim()) ||
    (typeof outputDetails.error === 'string' && outputDetails.error.trim()) ||
    '';

  const outputCandidate =
    parsed.output !== undefined ? parsed.output : outputDetails.output;
  const outputText =
    typeof outputCandidate === 'string'
      ? outputCandidate
      : outputCandidate !== undefined
        ? stringifyForDisplay(outputCandidate)
        : '';

  const toolName =
    typeof parsed.toolName === 'string'
      ? parsed.toolName.trim()
      : typeof parsed.tool === 'string'
        ? parsed.tool.trim()
        : '';

  const edits = Array.isArray(parsed.edits)
    ? parsed.edits
    : Array.isArray(outputDetails.edits)
      ? outputDetails.edits
      : [];

  const filesCandidate = Array.isArray(parsed.files)
    ? parsed.files
    : Array.isArray(outputDetails.files)
      ? outputDetails.files
      : edits
          .map((entry) => (entry?.path ? { path: entry.path } : null))
          .filter(Boolean);
  const files = normalizeFileListEntries(filesCandidate) || [];

  return {
    parsed,
    toolName,
    summaryText,
    errorText,
    outputText,
    input: parsed.input,
    files,
    isError: Boolean(
      parsed.isError || outputDetails.isError || errorText.length > 0,
    ),
    headerSummary: summaryText || errorText,
  };
};

/**
 * Represents different task group hierarchy levels with associated behaviors
 */
export const TaskGroupLevel = {
  ROOT: {
    name: 'root',
    formatTime: (date) => {
      return DATE_TIME_FORMATTER.format(date);
    },
    showTitle: false,
    headerOrder: 'time-first', // time → bullet → usage
    cssClass: 'top-level',
  },
  NESTED: {
    name: 'nested',
    formatTime: (date) => {
      return TIME_FORMATTER.format(date);
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
    this._formatters = this._buildFormatterMap();
    this._autoExpandedTypes = new Set(['thinking', 'scratchpad']);
  }

  _initializeMarkdown() {
    this.md = getMarkdownRenderer();
  }

  _buildFormatterMap() {
    return {
      thinking: (message) =>
        this._safeFormat(
          () =>
            this._formatBannerContent(
              message.normalizedPayload,
              'Thinking',
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'thinking',
        ),
      scratchpad: (message) =>
        this._safeFormat(
          () =>
            this._formatBannerContent(
              message.normalizedPayload,
              'Scratchpad',
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'scratchpad',
        ),
      toolUse: (message) =>
        this._safeFormat(
          () =>
            this._formatToolUse(
              message.normalizedPayload,
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'tool use',
        ),
      modelResponse: (message) =>
        this._safeFormat(
          () =>
            this._formatModelResponse({
              id: message.id,
              groupId: message.groupId,
              timestamp: message.timestamp,
              verbose: message.verbose,
              content: message.normalizedPayload,
              level: message.level,
            }),
          'Assistant',
        ),
      fileList: (message) =>
        this._safeFormat(
          () => this._formatFileList(message.normalizedPayload, message.id),
          'file list',
        ),
      missingOutputs: (message) =>
        this._safeFormat(
          () =>
            this._formatMissingOutputs(message.normalizedPayload, message.id),
          'missing outputs',
        ),
      latexdiff: (message) =>
        this._safeFormat(
          () => this._formatLatexdiff(message.normalizedPayload, message.id),
          'latexdiff',
        ),
      statistics: (message) =>
        this._safeFormat(
          () => this._formatStatistics(message.normalizedPayload, message.id),
          'statistics',
        ),
      userMessage: (message) =>
        this._safeFormat(
          () =>
            this._formatUserMessage(
              message.normalizedPayload,
              message.id,
              message.timestamp,
            ),
          'user message',
        ),
      progressStatus: (message) =>
        this._safeFormat(
          () => this._formatProgressStatus(message),
          'progress status',
        ),
    };
  }

  _applyOpenState(element, shouldOpen) {
    if (!(element instanceof HTMLElement) || element.tagName !== 'DETAILS') {
      return;
    }

    if (shouldOpen === undefined) {
      return;
    }

    if (shouldOpen) {
      element.setAttribute('open', '');
    } else {
      element.removeAttribute('open');
    }

    const toggleIcon = element.querySelector('.toggle-icon');
    if (toggleIcon) {
      toggleIcon.className = `${
        shouldOpen ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS
      } toggle-icon`;
    }
  }

  _resolveOpenState(messageType, options) {
    if (!options) {
      return undefined;
    }

    if (options.preservedOpen !== undefined) {
      return options.preservedOpen;
    }

    if (options.defaultOpen && this._autoExpandedTypes.has(messageType)) {
      return true;
    }

    return undefined;
  }

  /**
   * Format timestamp consistently across all methods
   * @param {Date} date - Date object to format
   * @returns {{fullTimestamp: string, timeDisplay: string}} Formatted timestamps
   */
  _formatTimestamp(date) {
    const isoTimestamp = date.toISOString();

    return {
      fullTimestamp: isoTimestamp,
      timeDisplay: TIME_FORMATTER.format(date),
      tooltipTimestamp: DATE_TIME_FORMATTER.format(date),
    };
  }

  /**
   * Process markdown content with LaTeX reference protection
   * @param {string} content - Raw content to process
   * @param {boolean} decode - Whether to decode HTML entities (default: true)
   * @returns {string} Processed markdown HTML
   */
  _processMarkdownContent(content, decode = false) {
    if (decode) {
      content = decodeHtml(content);
    }

    // Pre-process LaTeX references to protect them from markdown parsing
    content = content.replace(/\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');
    content = content.replace(/\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@');
    content = content.replace(/\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');

    const renderer = this.md || getMarkdownRenderer();

    // Process content as markdown
    let parsedMarkdown = renderer.render(content);

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
  format(logMessage, options = {}) {
    const messageWithPayload = {
      ...logMessage,
      normalizedPayload: normalizeStructuredContent(
        logMessage.text,
        logMessage.data,
      ),
    };

    const { id, text, level, timestamp, groupId, messageType, verbose } =
      messageWithPayload;

    const emoji = EMOJI_BY_LEVEL[level] || '•';
    const date = new Date(timestamp);
    const { fullTimestamp, timeDisplay, tooltipTimestamp } =
      this._formatTimestamp(date);

    const formatter = messageType ? this._formatters[messageType] : null;

    if (typeof formatter === 'function') {
      const result = formatter(messageWithPayload);
      if (result) {
        if (result instanceof HTMLElement) {
          const openOverride = this._resolveOpenState(messageType, options);
          this._applyOpenState(result, openOverride);
        }
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

  _formatBannerContent(
    normalizedPayload,
    contentType,
    logId,
    groupId,
    timestamp,
  ) {
    const decodedContent = normalizedPayload?.decodedText || '';
    const trimmedContent = decodedContent.trim();

    if (!trimmedContent) return null;

    const parsedMarkdown = this._processMarkdownContent(trimmedContent, false);
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

    bannerEntry.contentElem.dataset.rawContent = trimmedContent;
    bannerEntry.contentElem.innerHTML = parsedMarkdown;

    return bannerEntry.element;
  }

  _formatToolUse(normalizedPayload, logId, groupId, timestamp) {
    const element = createFromTemplate('toolUseTemplate');
    if (!element) return null;

    if (logId) element.dataset.logId = logId;
    if (groupId) element.dataset.groupId = groupId;
    if (timestamp) element.dataset.fullTimestamp = timestamp;

    const headerLabel = element.querySelector('.tool-use-title');
    const iconElem = headerLabel ? headerLabel.previousElementSibling : null;
    const toggleIcon = element.querySelector('.toggle-icon');
    if (toggleIcon) toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;
    if (headerLabel) headerLabel.textContent = 'Tool Use';
    if (iconElem) iconElem.className = 'codicon codicon-wrench';
    element.classList.remove('tool-use-error');

    const contentElem = element.querySelector('.banner-content');
    if (!contentElem) {
      return element;
    }

    const { structured } = normalizedPayload || {};
    const normalizedToolLog = normalizeToolUseLog(structured);

    if (!normalizedToolLog) {
      return null;
    }

    const {
      parsed,
      toolName,
      summaryText,
      errorText,
      outputText,
      input,
      files,
    } = normalizedToolLog;

    const titlePrefix = normalizedToolLog.isError ? 'Tool Error' : 'Tool Use';
    const titleBase = toolName ? `${titlePrefix}: ${toolName}` : titlePrefix;
    const titleText = normalizedToolLog.headerSummary
      ? `${titleBase} — ${normalizedToolLog.headerSummary}`
      : titleBase;

    if (headerLabel) headerLabel.textContent = titleText;
    if (iconElem) {
      iconElem.className = normalizedToolLog.isError
        ? 'codicon codicon-error'
        : 'codicon codicon-wrench';
    }
    element.classList.toggle('tool-use-error', normalizedToolLog.isError);

    const sections = [];

    if (input !== undefined) {
      const inputValue = stringifyForDisplay(input);
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Input:</span>
            <pre>${encodeHtml(inputValue)}</pre>
          </div>
        </div>
      `);
    }

    if (files && files.length > 0) {
      const renderData = buildFileListRender(files);
      if (renderData?.items) {
        sections.push(`
          <div class="tool-use-section">
            <div class="tool-use-subsection">
              <span class="tool-use-sublabel">Edited files:</span>
              <span class="file-list-summary">${encodeHtml(renderData.summary)}</span>
              <ul class="detail-list">${renderData.items}</ul>
            </div>
          </div>
        `);
      }
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
    } else if (outputText) {
      sections.push(`
        <div class="tool-use-section">
          <div class="tool-use-subsection">
            <span class="tool-use-sublabel">Output:</span>
            <pre class="tool-output-full">${encodeHtml(outputText)}</pre>
          </div>
        </div>
      `);
    }

    const fallbackYaml = stringifyForDisplay(parsed);
    contentElem.innerHTML =
      sections.length === 0
        ? `<pre>${encodeHtml(fallbackYaml || '')}</pre>`
        : sections.join('<hr class="tool-use-separator">');

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

    const decodedContent = content.decodedText || '';
    const trimmedContent = decodedContent.trim();
    if (!trimmedContent) {
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
      const timestampElem = document.createElement('span');
      timestampElem.classList.add('timestamp');
      timestampElem.title = tooltipTimestamp;
      timestampElem.textContent = verbose ? `[${timeDisplay}]` : '';
      summaryElem.insertBefore(
        timestampElem,
        summaryElem.querySelector('.banner-content-copy'),
      );
    }

    if (contentElem) {
      contentElem.classList.add(`message-${level}`);
      contentElem.dataset.rawContent = trimmedContent;
      contentElem.innerHTML = this._processMarkdownContent(
        trimmedContent,
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

    this._applyOpenState(element, Boolean(open));

    if (logId) element.dataset.logId = logId;
    if (groupId) element.dataset.groupId = groupId;
    if (timestamp) element.dataset.fullTimestamp = timestamp;

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

    const labelElem = element.querySelector('.label');
    if (labelElem) {
      labelElem.textContent = labelText ?? '';
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

  _formatFileList(normalizedPayload, logId) {
    const element = createFromTemplate('fileListDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.file-list-content');
    const summaryElem = element.querySelector('.summary-text');
    const toggleIcon = element.querySelector('.toggle-icon');
    if (toggleIcon) toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;

    let parsed =
      normalizeFileListEntries(normalizedPayload?.structured) || undefined;

    if (!parsed && normalizedPayload?.decodedText) {
      try {
        const parsedJson = JSON.parse(normalizedPayload.decodedText);
        parsed = normalizeFileListEntries(parsedJson) || undefined;
      } catch {
        // Fall through to raw display
      }
    }

    if (!parsed) {
      const rawContent = normalizedPayload?.decodedText ?? '';
      if (summaryElem) summaryElem.textContent = 'Files (raw)';
      if (contentElem) {
        contentElem.innerHTML = `<pre>${encodeHtml(rawContent)}</pre>`;
        if (logId) contentElem.dataset.logId = logId;
      }
      return element;
    }

    const renderData = buildFileListRender(parsed);
    const items = renderData?.items ?? '';
    const summary = renderData?.summary ?? 'Files';

    if (summaryElem) summaryElem.textContent = summary;
    if (contentElem) {
      contentElem.innerHTML = items;
      if (logId) contentElem.dataset.logId = logId;
    }

    return element;
  }

  _formatMissingOutputs(normalizedPayload, logId) {
    const element = createFromTemplate('missingOutputsDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.file-list-content');
    const summaryElem = element.querySelector('.summary-text');
    const toggleIcon = element.querySelector('.toggle-icon');
    if (toggleIcon) toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;

    const parsed = normalizeMissingOutputsPayload(
      normalizedPayload?.structured,
    );

    if (!parsed) {
      console.warn('Missing structured data for missing outputs log entry');
      return null;
    }

    const { missing, xmlFile, documentTag } = parsed;

    const items = missing
      .map((f) => {
        const filePath = String(f);
        const escaped = encodeHtml(filePath);
        const fileName = getBasename(filePath);
        const fileNameEscaped = encodeHtml(fileName);
        return `<li class="detail-item" title="${escaped}"><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span></li>`;
      })
      .join('');

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

    if (missing.length === 0 && xmlFile) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = xmlLink;
      const element = wrapper.firstElementChild;
      if (!element) {
        console.error('Failed to create XML link element from HTML:', xmlLink);
        return null;
      }
      return element;
    }

    const summary = `Missing outputs (${missing.length})`;

    if (summaryElem) summaryElem.textContent = summary;
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

  _formatLatexdiff(normalizedPayload, logId) {
    const element = createFromTemplate('latexdiffDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.latexdiff-content');
    const summaryElem = element.querySelector('.summary-text');
    const toggleIcon = element.querySelector('.toggle-icon');
    if (toggleIcon) toggleIcon.className = `${CHEVRON_DOWN_CLASS} toggle-icon`;

    const entries = normalizeLatexdiffEntries(normalizedPayload?.structured);

    if (!entries || entries.length === 0) {
      return null;
    }

    const toStringOrEmpty = (value) =>
      typeof value === 'string' && value.length > 0 ? value : '';
    const toLocation = (value) =>
      value && typeof value === 'object' ? value : null;
    const describeLocation = (location) => {
      if (!location) return '';
      // Trust the discriminated union - kind field is the source of truth
      if (location.kind === 'workspace' || location.kind === 'runStorage') {
        return location.relativePath || '';
      }
      return '';
    };
    const pickAbsolutePath = (location, fallback) => {
      if (
        location &&
        typeof location.absolutePath === 'string' &&
        location.absolutePath
      ) {
        return location.absolutePath;
      }
      return fallback;
    };

    let aggregatedRunId = '';
    let items = '';

    entries.forEach((d) => {
      const locations = d && typeof d === 'object' ? d.locations : null;
      const baseLocation = toLocation(locations ? locations.base : null);
      const revisedLocation = toLocation(locations ? locations.revised : null);
      const diffLocation = toLocation(locations ? locations.diff : null);

      const basePath = toStringOrEmpty(d.basePath);
      const revisedPath = toStringOrEmpty(d.revisedPath);
      const diffPath = toStringOrEmpty(d.diffPath);
      const msg = toStringOrEmpty(d.message);
      const baseLabel = toStringOrEmpty(d.baseLabel);
      const revisedLabel = toStringOrEmpty(d.revisedLabel);
      const runId = toStringOrEmpty(d.runId);
      if (runId && !aggregatedRunId) {
        aggregatedRunId = runId;
      }

      const baseFile = pickAbsolutePath(baseLocation, basePath);
      const revisedFile = pickAbsolutePath(revisedLocation, revisedPath);
      const diffFile = pickAbsolutePath(diffLocation, diffPath);

      const baseDisplayRaw =
        describeLocation(baseLocation) || baseLabel || getBasename(baseFile);
      const revisedDisplayRaw =
        describeLocation(revisedLocation) ||
        revisedLabel ||
        getBasename(revisedFile || baseFile);
      const diffDisplayRaw =
        describeLocation(diffLocation) ||
        (diffFile ? getBasename(diffFile) : '') ||
        'diff';

      let icon = 'codicon-question';
      if (d.status === 'success') {
        icon = 'codicon-check';
      } else if (d.status === 'error') {
        icon = 'codicon-error';
      }

      const titleAttr = msg ? ` title="${encodeHtml(msg)}"` : '';
      const runAttr = runId ? ` data-run-id="${encodeHtml(runId)}"` : '';

      const baseLink = baseFile
        ? `<span class="file-link clickable-link" data-file="${encodeHtml(baseFile)}">${encodeHtml(baseDisplayRaw)}</span>`
        : `<span>${encodeHtml(baseDisplayRaw)}</span>`;
      const revisedLink = revisedFile
        ? `<span class="file-link clickable-link" data-file="${encodeHtml(revisedFile)}">${encodeHtml(revisedDisplayRaw)}</span>`
        : `<span>${encodeHtml(revisedDisplayRaw)}</span>`;
      const diffLink = diffFile
        ? `<span class="file-link clickable-link" data-file="${encodeHtml(diffFile)}">${encodeHtml(diffDisplayRaw)}</span>`
        : `<span>${encodeHtml(diffDisplayRaw)}</span>`;

      items += `<li class="detail-item"${runAttr}><i class="codicon ${icon}"${titleAttr}></i> ${baseLink} <span class="arrow">&rarr;</span> ${revisedLink} (${diffLink})</li>`;
    });

    const summary =
      entries.length === 1
        ? 'Latexdiff result'
        : `Latexdiff results (${entries.length})`;

    if (summaryElem) summaryElem.textContent = summary;
    if (contentElem) {
      contentElem.innerHTML = items;
      if (logId) contentElem.dataset.logId = logId;
      if (aggregatedRunId) {
        contentElem.dataset.runId = aggregatedRunId;
      }
    }

    return element;
  }

  _formatStatistics(normalizedPayload, logId) {
    const element = createFromTemplate('statisticsDetailsTemplate');
    if (!element) return null;
    const contentElem = element.querySelector('.statistics-content');
    const toggleIcon = element.querySelector('.toggle-icon');
    if (toggleIcon) toggleIcon.className = `${CHEVRON_RIGHT_CLASS} toggle-icon`;
    const parsed = normalizedPayload?.structured;
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

  _formatProgressStatus(message) {
    const normalizedPayload = message.normalizedPayload || {};
    const severity = message.level || 'info';
    const date = new Date(message.timestamp ?? Date.now());
    const { fullTimestamp, timeDisplay, tooltipTimestamp } =
      this._formatTimestamp(date);

    const summaryText =
      (normalizedPayload.decodedText || message.text || '').trim() ||
      'Status update';
    const detailText = stringifyForDisplay(normalizedPayload.structured);
    const emoji = EMOJI_BY_LEVEL[severity] || '•';

    const container = document.createElement('div');
    container.dataset.fullTimestamp = fullTimestamp;
    if (message.id) container.dataset.logId = message.id;
    if (message.groupId) container.dataset.groupId = message.groupId;

    const summaryLine = document.createElement('div');
    summaryLine.className = 'log-line';
    summaryLine.innerHTML = `<span class="timestamp" title="${tooltipTimestamp}">${emoji} [${timeDisplay}]</span> <span class="message-${severity}">${encodeHtml(summaryText)}</span>`;
    container.appendChild(summaryLine);

    if (detailText) {
      const detailLine = document.createElement('pre');
      detailLine.className = `log-line message-${severity}`;
      detailLine.textContent = detailText;
      container.appendChild(detailLine);
    }

    return container;
  }

  _formatUserMessage(normalizedPayload, logId, timestamp) {
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
      const decodedContent = normalizedPayload?.decodedText || '';
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

    header.id = `${GROUP_DOM_IDS.HEADER_PREFIX}${group.id}`;
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
      case STREAM_STATUS.RUNNING:
        return '<i class="codicon codicon-sync spin"></i>';
      case STREAM_STATUS.ERROR:
        return '<i class="codicon codicon-error"></i>';
      case STREAM_STATUS.STOPPED:
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

let sharedLogEntryFormatter;

export const getSharedLogEntryFormatter = () => {
  if (!sharedLogEntryFormatter) {
    sharedLogEntryFormatter = new LogEntryFormatter();
  }
  return sharedLogEntryFormatter;
};

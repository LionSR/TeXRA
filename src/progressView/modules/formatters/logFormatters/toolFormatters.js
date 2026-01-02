/**
 * Tool-style formatters for tool use and web search messages.
 */

import { createFromTemplate } from '@common/templateUtils.js';
import { encodeHtml } from '@common/htmlEncoding.js';
import {
  setElementDataset,
  initToggleIcon,
  buildToolUseSection,
  wrapInPre,
  buildEditedFilesSection,
  buildCompactInput,
} from '../htmlBuilders.js';
import { normalizeToolUseLog, stringifyForDisplay } from '../normalizers.js';
import { QUERY_PREVIEW_MAX_LENGTH, TOOL_ICONS } from '../constants.js';

/**
 * Get the appropriate icon class for a tool
 * @param {string} toolName - The tool name
 * @returns {string} The codicon class
 */
const getToolIcon = (toolName) => {
  if (!toolName) return TOOL_ICONS.default;

  // Normalize tool name (convert CamelCase to snake_case, remove 'Tool' suffix)
  const normalized = toolName
    .replace(/Tool$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();

  return TOOL_ICONS[normalized] || TOOL_ICONS.default;
};

/**
 * Create and initialize a tool-style element from template
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @param {string} iconClass - Initial icon class (e.g., 'codicon-wrench')
 * @returns {{element: HTMLElement, headerLabel: HTMLElement|null, iconElem: HTMLElement|null, contentElem: HTMLElement|null}|null}
 */
const createToolElement = (logId, groupId, timestamp, iconClass) => {
  const element = createFromTemplate('toolUseTemplate');
  if (!element) return null;

  setElementDataset(element, { logId, groupId, timestamp });
  initToggleIcon(element, false);

  const headerLabel = element.querySelector('.tool-use-title');
  const iconElem = headerLabel ? headerLabel.previousElementSibling : null;
  const contentElem = element.querySelector('.banner-content');

  if (iconElem) iconElem.className = `codicon ${iconClass}`;
  element.classList.remove('tool-use-error');

  return { element, headerLabel, iconElem, contentElem };
};

/**
 * Format tool use log entry
 * @param {object} normalizedPayload - Normalized payload with structured data
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} Tool use element or null
 */
export const formatToolUse = (normalizedPayload, logId, groupId, timestamp) => {
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
    editedFiles,
  } = normalizedToolLog;

  // Get tool-specific icon
  const toolIcon = normalizedToolLog.isError
    ? 'codicon-error'
    : getToolIcon(toolName);

  const toolElement = createToolElement(logId, groupId, timestamp, toolIcon);
  if (!toolElement) return null;

  const { element, headerLabel, iconElem, contentElem } = toolElement;

  // Build title with tool name and summary
  const titlePrefix = normalizedToolLog.isError ? 'Error' : '';
  const titleBase = toolName || 'Tool Use';
  const titleText = normalizedToolLog.headerSummary
    ? `${titlePrefix ? titlePrefix + ': ' : ''}${titleBase} — ${normalizedToolLog.headerSummary}`
    : `${titlePrefix ? titlePrefix + ': ' : ''}${titleBase}`;

  if (headerLabel) headerLabel.textContent = titleText;
  if (iconElem) {
    iconElem.className = `codicon ${toolIcon}`;
  }
  element.classList.toggle('tool-use-error', normalizedToolLog.isError);

  if (!contentElem) {
    return element;
  }

  const sections = [];

  // Input section - use compact display for small inputs
  if (input !== undefined) {
    const inputHtml = buildCompactInput(input);
    if (inputHtml) {
      sections.push(buildToolUseSection('Input:', inputHtml));
    }
  }

  // Error or output section
  if (errorText) {
    sections.push(buildToolUseSection('Error:', wrapInPre(errorText)));
  } else if (outputText) {
    sections.push(
      buildToolUseSection('Output:', wrapInPre(outputText, 'tool-output-full')),
    );
  }

  // Edited files section - clickable links with line stats
  if (editedFiles && editedFiles.length > 0) {
    const filesHtml = buildEditedFilesSection(editedFiles);
    if (filesHtml) {
      sections.push(filesHtml);
    }
  }

  const fallbackYaml = stringifyForDisplay(parsed);
  contentElem.innerHTML =
    sections.length === 0
      ? wrapInPre(fallbackYaml || '')
      : sections.join('<hr class="tool-use-separator">');

  return element;
};

/**
 * Format web search results from native provider tools (Anthropic, OpenAI)
 * @param {object} normalizedPayload - Payload containing structured WebSearchResult
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} Web search element or null
 */
export const formatWebSearch = (
  normalizedPayload,
  logId,
  groupId,
  timestamp,
) => {
  const toolElement = createToolElement(
    logId,
    groupId,
    timestamp,
    'codicon-globe',
  );
  if (!toolElement) return null;

  const { element, headerLabel, iconElem, contentElem } = toolElement;

  if (!contentElem) {
    return element;
  }

  const { structured } = normalizedPayload || {};
  if (!structured || typeof structured !== 'object') {
    return null;
  }

  const { query, results, provider, status } = structured;
  const resultCount = Array.isArray(results) ? results.length : 0;

  // Build title based on provider (anthropic or openai)
  const providerLabel =
    provider === 'anthropic'
      ? 'Anthropic'
      : provider === 'openai'
        ? 'OpenAI'
        : 'Web';
  const queryPreview = query
    ? `: "${query.length > QUERY_PREVIEW_MAX_LENGTH ? query.slice(0, QUERY_PREVIEW_MAX_LENGTH) + '...' : query}"`
    : '';
  const statusSuffix =
    status === 'in_progress'
      ? ' (searching...)'
      : status === 'failed'
        ? ' (failed)'
        : '';
  const titleText = `${providerLabel} Search${queryPreview}${statusSuffix}`;

  if (headerLabel) headerLabel.textContent = titleText;
  if (iconElem) {
    iconElem.className =
      status === 'failed'
        ? 'codicon codicon-error'
        : status === 'in_progress'
          ? 'codicon codicon-sync spin'
          : 'codicon codicon-globe';
  }
  element.classList.toggle('tool-use-error', status === 'failed');

  // Build content sections
  const sections = [];

  if (query) {
    sections.push(buildToolUseSection('Query:', wrapInPre(query)));
  }

  if (resultCount > 0) {
    const resultItems = results
      .map((r) => {
        const url = r.url || '';
        const title = r.title || r.domain || url;
        const domain = r.domain || '';
        const urlEscaped = encodeHtml(url);
        const titleEscaped = encodeHtml(title);
        const domainDisplay = domain
          ? ` <span class="file-source">(${encodeHtml(domain)})</span>`
          : '';

        return `<li class="detail-item">
          <i class="codicon codicon-link"></i>
          <a href="${urlEscaped}" class="web-search-link" target="_blank" rel="noopener noreferrer">${titleEscaped}</a>${domainDisplay}
        </li>`;
      })
      .join('');

    const resultsContent = `
      <span class="file-list-summary">Results (${resultCount})</span>
      <ul class="detail-list">${resultItems}</ul>
    `;
    sections.push(buildToolUseSection('Sources:', resultsContent));
  } else if (status === 'completed') {
    sections.push(
      buildToolUseSection(
        'Sources:',
        '<span class="file-list-summary">No results found</span>',
      ),
    );
  }

  contentElem.innerHTML =
    sections.length === 0
      ? '<pre>Web search executed</pre>'
      : sections.join('<hr class="tool-use-separator">');

  return element;
};

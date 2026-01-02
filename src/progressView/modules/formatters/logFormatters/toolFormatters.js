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
  getToolIconClass,
} from '../htmlBuilders.js';
import { normalizeToolUseLog, stringifyForDisplay } from '../normalizers.js';
import { QUERY_PREVIEW_MAX_LENGTH } from '../constants.js';

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

  const { parsed, toolName, errorText, outputText, input } = normalizedToolLog;

  // Use tool-specific icon
  const iconClass = getToolIconClass(toolName, normalizedToolLog.isError);

  const toolElement = createToolElement(logId, groupId, timestamp, iconClass);
  if (!toolElement) return null;

  const { element, headerLabel, iconElem, contentElem } = toolElement;

  // Build title
  const titlePrefix = normalizedToolLog.isError ? 'Tool Error' : 'Tool Use';
  const titleBase = toolName ? `${titlePrefix}: ${toolName}` : titlePrefix;
  const titleText = normalizedToolLog.headerSummary
    ? `${titleBase} — ${normalizedToolLog.headerSummary}`
    : titleBase;

  if (headerLabel) {
    headerLabel.textContent = titleText;
  }

  if (iconElem) {
    iconElem.className = `codicon ${iconClass}`;
  }
  element.classList.toggle('tool-use-error', normalizedToolLog.isError);

  if (!contentElem) {
    return element;
  }

  const sections = [];

  // Show full input (key info is already in header summary)
  if (input !== undefined && input !== null) {
    const inputValue = stringifyForDisplay(input);
    if (inputValue) {
      sections.push(buildToolUseSection('Input:', wrapInPre(inputValue)));
    }
  }

  // Note: File path is already in headerSummary, so we skip the Files section

  // Show error or output
  if (errorText) {
    sections.push(buildToolUseSection('Error:', wrapInPre(errorText)));
  } else if (outputText) {
    sections.push(
      buildToolUseSection('Output:', wrapInPre(outputText, 'tool-output-full')),
    );
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

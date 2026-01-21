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
  buildFileLinkWithLines,
  buildEditDiffSection,
  wrapInHighlightedPre,
  detectLanguageFromPath,
} from '../htmlBuilders.js';
import { normalizeToolUseLog, stringifyForDisplay } from '../normalizers.js';

// Tools that benefit from specialized formatting
const EDIT_TOOLS = new Set(['edit_file', 'write_file']);
const READ_TOOLS = new Set(['read_file']);
const CODE_OUTPUT_TOOLS = new Set(['bash', 'execute', 'run']);

// Web search provider display names
const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

// Web search status suffixes for title
const STATUS_SUFFIXES = {
  in_progress: ' (searching...)',
  failed: ' (failed)',
};

// Web search status-based icon classes
const STATUS_ICONS = {
  failed: 'codicon codicon-error',
  in_progress: 'codicon codicon-sync spin',
};

/**
 * Determine the title prefix based on tool state.
 * @param {boolean} isUserFeedback - Whether this is user feedback
 * @param {boolean} isError - Whether this is an error state
 * @returns {string} The title prefix
 */
function getToolTitlePrefix(isUserFeedback, isError) {
  if (isUserFeedback) return 'User Feedback';
  if (isError) return 'Tool Error';
  return 'Tool Use';
}

/**
 * Create and initialize a tool-style element from template
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @param {string} iconClass - Initial icon class (e.g., 'codicon-wrench')
 * @returns {{element: HTMLElement, headerLabel: HTMLElement|null, iconElem: HTMLElement|null, contentElem: HTMLElement|null}|null}
 */
function createToolElement(logId, groupId, timestamp, iconClass) {
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
}

/**
 * Format tool use log entry
 * @param {object} normalizedPayload - Normalized payload with structured data
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} Tool use element or null
 */
export function formatToolUse(normalizedPayload, logId, groupId, timestamp) {
  const { structured } = normalizedPayload ?? {};
  const normalizedToolLog = normalizeToolUseLog(structured);

  if (!normalizedToolLog) {
    return null;
  }

  const {
    parsed,
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input,
    isUserFeedback,
  } = normalizedToolLog;

  // Determine display state: user feedback takes precedence over error styling
  const showAsError = normalizedToolLog.isError && !isUserFeedback;

  // Use appropriate icon: comment for user feedback, otherwise tool-specific
  const iconClass = isUserFeedback
    ? 'codicon-comment'
    : getToolIconClass(toolName, showAsError);

  const toolElement = createToolElement(logId, groupId, timestamp, iconClass);
  if (!toolElement) return null;

  const { element, headerLabel, contentElem } = toolElement;

  // Build title based on state
  const titlePrefix = getToolTitlePrefix(isUserFeedback, showAsError);
  const titleBase = toolName ? `${titlePrefix}: ${toolName}` : titlePrefix;

  const headerSummary = normalizedToolLog.headerSummary ?? '';

  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  if (headerLabel) {
    headerLabel.textContent = titleText;
  }

  // Apply appropriate styling class
  element.classList.toggle('tool-use-error', showAsError);
  element.classList.toggle('tool-use-user-feedback', isUserFeedback);

  if (!contentElem) {
    return element;
  }

  const sections = [];

  // Get file path from input for specialized formatting
  const filePath =
    typeof input === 'object' && input !== null ? input.path : '';

  // Handle edit tools with inline diff display
  if (EDIT_TOOLS.has(toolName) && input?.old_string && input?.new_string) {
    // Show file path as link
    if (filePath) {
      sections.push(
        buildToolUseSection(
          'File:',
          buildFileLinkWithLines(filePath, {}),
        ),
      );
    }
    // Show inline diff for old_string → new_string
    sections.push(
      buildToolUseSection(
        'Changes:',
        buildEditDiffSection(input.old_string, input.new_string, filePath),
      ),
    );
  }
  // Handle read tools with file link instead of full content
  else if (READ_TOOLS.has(toolName) && filePath) {
    // Parse line info from output summary or input range
    const range = input?.range;
    const startLine = range?.start ?? 1;
    const endLine = range?.end;

    // Count total lines from output if available
    const outputLines = outputText ? outputText.split('\n').length : undefined;

    sections.push(
      buildToolUseSection(
        'File:',
        buildFileLinkWithLines(filePath, {
          startLine,
          endLine,
          totalLines: outputLines,
        }),
      ),
    );

    // Don't show full file content - just the link
    // Output is available via the file link click
  }
  // Default handling for other tools
  else if (input !== undefined && input !== null) {
    const inputValue = stringifyForDisplay(input);
    if (inputValue) {
      // Use syntax highlighting for code-related tools
      if (CODE_OUTPUT_TOOLS.has(toolName)) {
        sections.push(
          buildToolUseSection('Input:', wrapInHighlightedPre(inputValue, 'bash')),
        );
      } else {
        sections.push(buildToolUseSection('Input:', wrapInPre(inputValue)));
      }
    }
  }

  // Show output if present (primary result from tool)
  // Skip for read tools (already shown as file link)
  if (outputText && !READ_TOOLS.has(toolName)) {
    // Use syntax highlighting for code outputs
    const language = detectLanguageFromPath(filePath) || (CODE_OUTPUT_TOOLS.has(toolName) ? 'bash' : '');
    if (language) {
      sections.push(
        buildToolUseSection('Output:', wrapInHighlightedPre(outputText, language, 'tool-output-full')),
      );
    } else {
      sections.push(
        buildToolUseSection('Output:', wrapInPre(outputText, 'tool-output-full')),
      );
    }
  }

  // Show error if present and not superseded by user feedback
  if (errorText && !isUserFeedback) {
    sections.push(
      buildToolUseSection('Error:', wrapInPre(errorText, 'tool-error-content')),
    );
  }

  // Show user instruction as supplementary note/warning if present
  if (isUserFeedback && userInstructionText) {
    sections.push(
      buildToolUseSection(
        'User Instruction:',
        wrapInPre(userInstructionText, 'tool-user-feedback'),
      ),
    );
  }

  const fallbackYaml = stringifyForDisplay(parsed);
  contentElem.innerHTML =
    sections.length === 0
      ? wrapInPre(fallbackYaml || '')
      : sections.join('<hr class="tool-use-separator">');

  return element;
}

/**
 * Format web search results from native provider tools (Anthropic, OpenAI)
 * @param {object} normalizedPayload - Payload containing structured WebSearchResult
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} Web search element or null
 */
export function formatWebSearch(normalizedPayload, logId, groupId, timestamp) {
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

  const { structured } = normalizedPayload ?? {};
  if (!structured || typeof structured !== 'object') {
    return null;
  }

  const { query, results, provider, status } = structured;
  const resultCount = Array.isArray(results) ? results.length : 0;

  const providerLabel = PROVIDER_LABELS[provider] ?? 'Web';
  const statusSuffix = STATUS_SUFFIXES[status] ?? '';

  let titleText = `${providerLabel} Search`;
  if (query) {
    titleText += `: "${query}"`;
  }
  titleText += statusSuffix;

  if (headerLabel) headerLabel.textContent = titleText;
  if (iconElem) {
    iconElem.className = STATUS_ICONS[status] ?? 'codicon codicon-globe';
  }
  element.classList.toggle('tool-use-error', status === 'failed');

  // Build content sections
  const sections = [];

  if (query) {
    sections.push(buildToolUseSection('Query:', wrapInPre(query)));
  }

  if (resultCount > 0) {
    const resultItems = results.map((r) => {
      const url = r.url || '';
      const title = encodeHtml(r.title || r.domain || url);
      const domainSuffix = r.domain
        ? ` <span class="file-source">(${encodeHtml(r.domain)})</span>`
        : '';
      return `<li class="detail-item"><i class="codicon codicon-link"></i> <a href="${encodeHtml(url)}" class="web-search-link" target="_blank" rel="noopener noreferrer">${title}</a>${domainSuffix}</li>`;
    });

    sections.push(
      buildToolUseSection(
        'Sources:',
        `<span class="file-list-summary">Results (${resultCount})</span><ul class="detail-list">${resultItems.join('')}</ul>`,
      ),
    );
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
}

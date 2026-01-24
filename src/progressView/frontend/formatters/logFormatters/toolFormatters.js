/**
 * Tool-style formatters for tool use and web search messages.
 */

import { createFromTemplate } from '../templateUtils.ts';
import { encodeHtml } from '@common/modules/htmlEncoding.js';
import {
  setElementDataset,
  initToggleIcon,
  buildToolUseSection,
  wrapInPre,
  getToolIconClass,
  buildFileLinkWithLines,
  buildEditDiffSection,
  buildCodeBlock,
} from '../htmlBuilders.js';
import {
  normalizeToolUseLog,
  stringifyWithLanguage,
  extractCodeOnlyInput,
} from '../normalizers.js';
import {
  TOOLS_WITH_DIFF_INPUT,
  TOOLS_WITH_FILE_LINK,
  TOOLS_WITH_FILE_CONTENT,
  TOOL_OUTPUT_LANGUAGES,
  TOOL_CODE_LANGUAGES,
  getLanguageFromPath,
} from '../constants.js';

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
 * Build a tool section with appropriate code highlighting based on tool type and content.
 * Uses explicit language from tool config or content metadata - never auto-detects.
 *
 * @param {string} label - Section label (e.g., 'Input:', 'Output:')
 * @param {string} text - Content text to display
 * @param {object} options - Display options
 * @param {string} options.toolName - Name of the tool
 * @param {string} [options.language] - Explicit language override (from stringifyWithLanguage)
 * @param {string} [options.extraClass] - Additional CSS class for the content
 * @returns {string} HTML for the section
 */
function buildToolSection(label, text, options = {}) {
  const { toolName = '', language: contentLanguage, extraClass = '' } = options;

  // Determine language: tool config > content metadata > plaintext
  const toolLanguage = TOOL_OUTPUT_LANGUAGES.get(toolName);
  const language = toolLanguage || contentLanguage || 'plaintext';

  // Only use highlighting for known languages, show badge for non-plaintext
  const shouldHighlight = language && language !== 'plaintext';

  const content = shouldHighlight
    ? buildCodeBlock(text, {
        language,
        className: extraClass,
        showLanguage: true,
        showCopy: true,
      })
    : wrapInPre(text, extraClass);

  return buildToolUseSection(label, content);
}

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
  // For normal tool use, just show the tool name (no "Tool Use:" prefix)
  // Keep prefixes for special states: "Tool Error:" and "User Feedback:"
  const titlePrefix = getToolTitlePrefix(isUserFeedback, showAsError);
  const isNormalToolUse = !isUserFeedback && !showAsError;
  const titleBase = toolName
    ? isNormalToolUse
      ? toolName
      : `${titlePrefix}: ${toolName}`
    : titlePrefix;

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

  // Handle edit tools with diff display for input
  // Note: edit_file uses old_str/new_str field names
  // old_str must be non-empty, but new_str can be empty (deletion operation)
  if (
    TOOLS_WITH_DIFF_INPUT.has(toolName) &&
    input?.old_str &&
    typeof input?.new_str === 'string'
  ) {
    if (filePath) {
      sections.push(
        buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
      );
    }
    sections.push(
      buildToolUseSection(
        'Changes:',
        buildEditDiffSection(input.old_str, input.new_str),
      ),
    );
  }
  // Handle read tools with file link instead of full content
  else if (TOOLS_WITH_FILE_LINK.has(toolName) && filePath) {
    const range = input?.range;
    sections.push(
      buildToolUseSection(
        'File:',
        buildFileLinkWithLines(filePath, {
          startLine: range?.start,
          endLine: range?.end,
        }),
      ),
    );
  }
  // Handle write tools with file link + syntax-highlighted content
  else if (
    TOOLS_WITH_FILE_CONTENT.has(toolName) &&
    filePath &&
    input?.content !== undefined
  ) {
    sections.push(
      buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
    );
    const contentLanguage = getLanguageFromPath(filePath);
    sections.push(
      buildToolSection('Content:', input.content, {
        toolName,
        language: contentLanguage,
      }),
    );
  }
  // Default handling for other tools
  else if (input !== undefined && input !== null) {
    // Check tool language first (cheap Map lookup) before extracting code
    const codeLanguage = TOOL_CODE_LANGUAGES.get(toolName);
    const { isCodeOnly, code } = codeLanguage
      ? extractCodeOnlyInput(input)
      : { isCodeOnly: false, code: '' };

    if (isCodeOnly) {
      // Show code with appropriate syntax highlighting instead of YAML
      sections.push(
        buildToolSection('Input:', code, {
          toolName,
          language: codeLanguage,
        }),
      );
    } else {
      const { text: inputValue, language: inputLanguage } =
        stringifyWithLanguage(input);
      if (inputValue) {
        sections.push(
          buildToolSection('Input:', inputValue, {
            toolName,
            language: inputLanguage,
          }),
        );
      }
    }
  }

  // Show output if present (primary result from tool)
  // Skip for read tools (already shown as file link)
  // Skip trivial "written" for write tools, but show if user adjusted content
  // (WriteTool outputs "written\n\n<diff>" when user modifies proposed content)
  const isWriteTool = TOOLS_WITH_FILE_CONTENT.has(toolName);
  const isTrivialWriteOutput = isWriteTool && outputText.trim() === 'written';
  if (
    outputText &&
    !TOOLS_WITH_FILE_LINK.has(toolName) &&
    !isTrivialWriteOutput
  ) {
    sections.push(
      buildToolSection('Output:', outputText, {
        toolName,
        extraClass: 'tool-output-full',
      }),
    );
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

  // Only compute fallback YAML when needed (avoid wasted yaml.stringify)
  if (sections.length === 0) {
    const { text: fallbackYaml, language: fallbackLanguage } =
      stringifyWithLanguage(parsed);
    contentElem.innerHTML = buildCodeBlock(fallbackYaml || '', {
      language: fallbackLanguage,
      showLanguage: fallbackLanguage !== 'plaintext',
      showCopy: true,
    });
  } else {
    contentElem.innerHTML = sections.join('<hr class="tool-use-separator">');
  }

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

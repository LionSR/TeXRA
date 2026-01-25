/**
 * Tool-style formatters for tool use and web search messages.
 */

// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';
import { encodeHtml } from '@common/modules/htmlEncoding.js';
// Local imports - formatter helpers
import {
  setElementDataset,
  initToggleIcon,
  buildToolUseSection,
  wrapInPre,
  getToolIconClass,
  buildFileLinkWithLines,
  buildEditDiffSection,
  buildCodeBlock,
} from '../htmlBuilders';
import {
  normalizeToolUseLog,
  stringifyWithLanguage,
  extractCodeOnlyInput,
  type NormalizedPayload,
} from '../normalizers';
import {
  TOOLS_WITH_DIFF_INPUT,
  TOOLS_WITH_FILE_LINK,
  TOOLS_WITH_FILE_CONTENT,
  TOOL_OUTPUT_LANGUAGES,
  TOOL_CODE_LANGUAGES,
  getLanguageFromPath,
} from '../constants';

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

type ToolSectionOptions = {
  toolName?: string;
  language?: string;
  extraClass?: string;
};

type WebSearchResult = {
  url?: string;
  title?: string;
  domain?: string;
};

type WebSearchPayload = {
  query?: string;
  results?: WebSearchResult[];
  provider?: string;
  status?: string;
};

/**
 * Build a tool section with appropriate code highlighting based on tool type and content.
 * Uses explicit language from tool config or content metadata - never auto-detects.
 */
function buildToolSection(
  label: string,
  text: string,
  options: ToolSectionOptions = {},
): string {
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

/** Determine the title prefix based on tool state. */
function getToolTitlePrefix(isUserFeedback: boolean, isError: boolean): string {
  if (isUserFeedback) return 'User Feedback';
  if (isError) return 'Tool Error';
  return 'Tool Use';
}

/** Create and initialize a tool-style element from template. */
function createToolElement(
  logId: string,
  groupId: string | undefined,
  timestamp: number,
  iconClass: string,
): {
  element: HTMLElement;
  headerLabel: HTMLElement | null;
  iconElem: Element | null;
  contentElem: HTMLElement | null;
} | null {
  const element = createFromTemplate('toolUseTemplate');
  if (!element) return null;

  const fullTimestamp = new Date(timestamp).toISOString();
  setElementDataset(element, { logId, groupId, timestamp: fullTimestamp });
  initToggleIcon(element, false);

  const headerLabel = element.querySelector('.tool-use-title');
  const iconElem = headerLabel ? headerLabel.previousElementSibling : null;
  const contentElem = element.querySelector('.banner-content');

  if (iconElem instanceof HTMLElement) {
    iconElem.className = `codicon ${iconClass}`;
  }
  element.classList.remove('tool-use-error');

  return {
    element,
    headerLabel: headerLabel instanceof HTMLElement ? headerLabel : null,
    iconElem: iconElem instanceof HTMLElement ? iconElem : null,
    contentElem: contentElem instanceof HTMLElement ? contentElem : null,
  };
}

/** Format tool use log entry. */
export function formatToolUse(
  normalizedPayload: NormalizedPayload,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
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

  const sections: string[] = [];

  // Get file path from input for specialized formatting
  const filePath =
    typeof input === 'object' && input !== null && 'path' in input
      ? String((input as { path?: string }).path ?? '')
      : '';

  // Handle edit tools with diff display for input
  // Note: edit_file uses old_str/new_str field names
  // old_str must be non-empty, but new_str can be empty (deletion operation)
  if (
    TOOLS_WITH_DIFF_INPUT.has(toolName) &&
    typeof input === 'object' &&
    input !== null &&
    'old_str' in input &&
    'new_str' in input &&
    typeof (input as { old_str?: string }).old_str === 'string' &&
    typeof (input as { new_str?: string }).new_str === 'string'
  ) {
    if (filePath) {
      sections.push(
        buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
      );
    }
    sections.push(
      buildToolUseSection(
        'Changes:',
        buildEditDiffSection(
          (input as { old_str: string }).old_str,
          (input as { new_str: string }).new_str,
        ),
      ),
    );
  }
  // Handle read tools with file link instead of full content
  else if (TOOLS_WITH_FILE_LINK.has(toolName) && filePath) {
    const range =
      typeof input === 'object' && input !== null && 'range' in input
        ? (input as { range?: { start?: number; end?: number } }).range
        : undefined;
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
    typeof input === 'object' &&
    input !== null &&
    'content' in input
  ) {
    sections.push(
      buildToolUseSection('File:', buildFileLinkWithLines(filePath)),
    );
    const contentLanguage = getLanguageFromPath(filePath);
    const rawContent = (input as { content?: unknown }).content;
    const contentText =
      typeof rawContent === 'string' ? rawContent : String(rawContent ?? '');
    sections.push(
      buildToolSection('Content:', contentText, {
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

/** Format web search results from native provider tools (Anthropic, OpenAI). */
export function formatWebSearch(
  normalizedPayload: NormalizedPayload,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
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

  const { query, results, provider, status } = structured as WebSearchPayload;
  const resultCount = Array.isArray(results) ? results.length : 0;
  const providerKey = typeof provider === 'string' ? provider : 'web';
  const statusKey = typeof status === 'string' ? status : '';

  const providerLabel =
    PROVIDER_LABELS[providerKey as keyof typeof PROVIDER_LABELS] ?? 'Web';
  const statusSuffix =
    STATUS_SUFFIXES[statusKey as keyof typeof STATUS_SUFFIXES] ?? '';

  let titleText = `${providerLabel} Search`;
  if (query) {
    titleText += `: "${query}"`;
  }
  titleText += statusSuffix;

  if (headerLabel) headerLabel.textContent = titleText;
  if (iconElem) {
    iconElem.className =
      STATUS_ICONS[statusKey as keyof typeof STATUS_ICONS] ??
      'codicon codicon-globe';
  }
  element.classList.toggle('tool-use-error', statusKey === 'failed');

  // Build content sections
  const sections: string[] = [];

  if (query) {
    sections.push(buildToolUseSection('Query:', wrapInPre(query)));
  }

  if (resultCount > 0) {
    const resultItems = (results ?? []).map((r) => {
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
  } else if (statusKey === 'completed') {
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

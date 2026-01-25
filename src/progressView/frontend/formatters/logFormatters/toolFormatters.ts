/**
 * Tool-style formatters for tool use and web search messages.
 * Uses Lit templates for declarative DOM construction.
 */

// Local imports - Lit template utilities
import {
  html,
  classMap,
  ifDefined,
  renderToElement,
  type TemplateResult,
} from '../litTemplates';

// Local imports - shared schemas

// Local imports - formatter helpers
import {
  buildToolUseSection,
  wrapInPre,
  getToolIconClass,
  buildFileLinkWithLines,
  buildEditDiffSection,
  buildCodeBlock,
  initToggleIcon,
  buildDetailsSummary,
} from '../htmlBuilders';
import { normalizeToolUseData } from '../logDataParsers';
import { stringifyWithLanguage, extractCodeOnlyInput } from '../parseUtils';
import {
  TOOLS_WITH_DIFF_INPUT,
  TOOLS_WITH_FILE_LINK,
  TOOLS_WITH_FILE_CONTENT,
  TOOL_OUTPUT_LANGUAGES,
  TOOL_CODE_LANGUAGES,
  TRIVIAL_WRITE_OUTPUT,
  getLanguageFromPath,
} from '../constants';
import type { WebSearchPayload } from '@shared/schemas';

/** Join template sections with horizontal rule separators. */
function joinWithSeparator(sections: TemplateResult[]): TemplateResult {
  return html`${sections.map(
    (section, i) =>
      html`${section}${i < sections.length - 1
        ? html`<hr class="tool-use-separator" />`
        : ''}`,
  )}`;
}

// Web search provider display names
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

// Web search status suffixes for title
const STATUS_SUFFIXES: Record<string, string> = {
  in_progress: ' (searching...)',
  failed: ' (failed)',
};

// Web search status-based icon classes
const STATUS_ICONS: Record<string, string> = {
  failed: 'codicon codicon-error',
  in_progress: 'codicon codicon-sync spin',
};

type ToolSectionOptions = {
  toolName?: string;
  language?: string;
  extraClass?: string;
};

/**
 * Build a tool section with appropriate code highlighting based on tool type.
 */
function buildToolSection(
  label: string,
  text: string,
  options: ToolSectionOptions = {},
): TemplateResult {
  const { toolName = '', language: contentLanguage, extraClass = '' } = options;

  // Determine language: tool config > content metadata > plaintext
  const toolLanguage = TOOL_OUTPUT_LANGUAGES.get(toolName);
  const language = toolLanguage || contentLanguage || 'plaintext';
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

/** Title prefix lookup based on tool state. */
function getToolTitlePrefix(isUserFeedback: boolean, isError: boolean): string {
  if (isUserFeedback) return 'User Feedback';
  if (isError) return 'Tool Error';
  return 'Tool Use';
}

/** Format tool use log entry. */
export function formatToolUse(
  data: unknown,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
  const normalizedToolLog = normalizeToolUseData(data);
  if (!normalizedToolLog) return null;

  const {
    parsed,
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input,
    isUserFeedback,
  } = normalizedToolLog;

  // Determine display state
  const showAsError = normalizedToolLog.isError && !isUserFeedback;
  const iconClass = isUserFeedback
    ? 'codicon-comment'
    : getToolIconClass(toolName, showAsError);

  // Build title
  const titlePrefix = getToolTitlePrefix(isUserFeedback, showAsError);
  const isNormalToolUse = !isUserFeedback && !showAsError;
  let titleBase: string;
  if (toolName && isNormalToolUse) {
    titleBase = toolName;
  } else if (toolName) {
    titleBase = `${titlePrefix}: ${toolName}`;
  } else {
    titleBase = titlePrefix;
  }

  const headerSummary = normalizedToolLog.headerSummary ?? '';
  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  // Build content sections
  const sections: TemplateResult[] = [];

  // Get file path from input for specialized formatting
  const filePath =
    typeof input === 'object' && input !== null && 'path' in input
      ? String((input as { path?: string }).path ?? '')
      : '';

  // Handle edit tools with diff display
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
  // Handle read tools with file link
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
  // Handle write tools with file link + content
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
    const codeLanguage = TOOL_CODE_LANGUAGES.get(toolName);
    const { isCodeOnly, code } = codeLanguage
      ? extractCodeOnlyInput(input)
      : { isCodeOnly: false, code: '' };

    if (isCodeOnly) {
      sections.push(
        buildToolSection('Input:', code, { toolName, language: codeLanguage }),
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

  // Show output if present
  const isWriteTool = TOOLS_WITH_FILE_CONTENT.has(toolName);
  const isTrivialWriteOutput =
    isWriteTool && outputText.trim() === TRIVIAL_WRITE_OUTPUT;
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

  // Show error if present
  if (errorText && !isUserFeedback) {
    sections.push(
      buildToolUseSection('Error:', wrapInPre(errorText, 'tool-error-content')),
    );
  }

  // Show user instruction if present
  if (isUserFeedback && userInstructionText) {
    sections.push(
      buildToolUseSection(
        'User Instruction:',
        wrapInPre(userInstructionText, 'tool-user-feedback'),
      ),
    );
  }

  // Fallback: show raw YAML
  const contentTemplate =
    sections.length === 0
      ? buildCodeBlock(stringifyWithLanguage(parsed).text ?? '', {
          language: 'yaml',
          showLanguage: true,
          showCopy: true,
        })
      : joinWithSeparator(sections);

  const fullTimestamp = new Date(timestamp).toISOString();

  const template = html`
    <details
      class=${classMap({
        'banner-details': true,
        'tool-use-details': true,
        'tool-use-error': showAsError,
        'tool-use-user-feedback': isUserFeedback,
      })}
    >
      ${buildDetailsSummary({
        iconClass,
        label: titleText,
        labelClass: 'tool-use-title',
        includeIconClass: false,
      })}
      <div
        class="banner-content log-entry-content"
        data-log-id=${ifDefined(logId)}
        data-group-id=${ifDefined(groupId)}
        data-timestamp=${ifDefined(fullTimestamp)}
      >
        ${contentTemplate}
      </div>
    </details>
  `;

  const element = renderToElement(template);
  if (element) initToggleIcon(element, false);
  return element;
}

/** Format web search results from native provider tools. */
export function formatWebSearch(
  data: unknown,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
  if (!data || typeof data !== 'object') return null;

  const { query, results, provider, status } = data as WebSearchPayload;
  const resultCount = Array.isArray(results) ? results.length : 0;
  const providerKey = typeof provider === 'string' ? provider : 'web';
  const statusKey = typeof status === 'string' ? status : '';

  const providerLabel = PROVIDER_LABELS[providerKey] ?? 'Web';
  const statusSuffix = STATUS_SUFFIXES[statusKey] ?? '';
  const iconClass = STATUS_ICONS[statusKey] ?? 'codicon codicon-globe';

  let titleText = `${providerLabel} Search`;
  if (query) titleText += `: "${query}"`;
  titleText += statusSuffix;

  // Build content sections
  const sections: TemplateResult[] = [];

  if (query) {
    sections.push(buildToolUseSection('Query:', wrapInPre(query)));
  }

  if (resultCount > 0) {
    const resultsTemplate = html`
      <span class="file-list-summary">Results (${resultCount})</span>
      <ul class="detail-list">
        ${(results ?? []).map(
          (r) => html`
            <li class="detail-item">
              <i class="codicon codicon-link"></i>
              <a
                href=${r.url ?? ''}
                class="web-search-link"
                target="_blank"
                rel="noopener noreferrer"
                >${r.title ?? r.domain ?? r.url}</a
              >
              ${r.domain
                ? html`<span class="file-source">(${r.domain})</span>`
                : ''}
            </li>
          `,
        )}
      </ul>
    `;
    sections.push(buildToolUseSection('Sources:', resultsTemplate));
  } else if (statusKey === 'completed') {
    sections.push(
      buildToolUseSection(
        'Sources:',
        html`<span class="file-list-summary">No results found</span>`,
      ),
    );
  }

  const contentTemplate =
    sections.length === 0
      ? html`<pre>Web search executed</pre>`
      : joinWithSeparator(sections);

  const fullTimestamp = new Date(timestamp).toISOString();

  const template = html`
    <details
      class=${classMap({
        'banner-details': true,
        'tool-use-details': true,
        'tool-use-error': statusKey === 'failed',
      })}
    >
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class=${iconClass}></i>
        <span class="tool-use-title">${titleText}</span>
      </summary>
      <div
        class="banner-content log-entry-content"
        data-log-id=${ifDefined(logId)}
        data-group-id=${ifDefined(groupId)}
        data-timestamp=${ifDefined(fullTimestamp)}
      >
        ${contentTemplate}
      </div>
    </details>
  `;

  const element = renderToElement(template);
  if (element) initToggleIcon(element, false);
  return element;
}

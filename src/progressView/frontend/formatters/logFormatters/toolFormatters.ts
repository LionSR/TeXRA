// Local imports
import { encodeHtml } from '../htmlEncoding';
import {
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
} from '../normalizers';
import {
  TOOLS_WITH_DIFF_INPUT,
  TOOLS_WITH_FILE_LINK,
  TOOLS_WITH_FILE_CONTENT,
  TOOL_OUTPUT_LANGUAGES,
  TOOL_CODE_LANGUAGES,
  getLanguageFromPath,
} from '../constants';
import { CHEVRON_DOWN_CLASS, CHEVRON_RIGHT_CLASS } from '../constants';
import { formatTimestamp } from '../timestampUtils';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

const STATUS_SUFFIXES: Record<string, string> = {
  in_progress: ' (searching...)',
  failed: ' (failed)',
};

const STATUS_ICONS: Record<string, string> = {
  failed: 'codicon codicon-error',
  in_progress: 'codicon codicon-sync spin',
};

const buildToolSection = (
  label: string,
  text: string,
  options: { toolName?: string; language?: string; extraClass?: string } = {},
): string => {
  const { toolName = '', language: contentLanguage, extraClass = '' } = options;
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
};

const getToolTitlePrefix = (isUserFeedback: boolean, isError: boolean) => {
  if (isUserFeedback) return 'User Feedback';
  if (isError) return 'Tool Error';
  return 'Tool Use';
};

const buildToolDetails = (options: {
  logId: string;
  groupId?: string;
  timestamp?: number;
  iconClass: string;
  title: string;
  contentHtml: string;
  open?: boolean;
  classes?: string[];
}) => {
  const {
    logId,
    groupId,
    timestamp,
    iconClass,
    title,
    contentHtml,
    open = false,
    classes = [],
  } = options;
  const toggleClass = open ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS;
  const fullTimestamp = timestamp
    ? formatTimestamp(new Date(timestamp)).fullTimestamp
    : '';
  const dataset = [
    logId ? ` data-log-id="${encodeHtml(logId)}"` : '',
    groupId ? ` data-group-id="${encodeHtml(groupId)}"` : '',
    fullTimestamp ? ` data-full-timestamp="${encodeHtml(fullTimestamp)}"` : '',
  ]
    .filter(Boolean)
    .join('');
  const openAttr = open ? ' open' : '';
  const extraClasses = classes.join(' ');

  return `
    <details class="banner-details ${extraClasses}"${dataset}${openAttr}>
      <summary class="details-summary">
        <i class="codicon ${iconClass}"></i>
        <span class="tool-use-title">${encodeHtml(title)}</span>
        <button class="banner-content-copy" title="Copy content" data-default-title="Copy content" data-success-title="Copied!"><i class="codicon codicon-copy"></i></button>
        <i class="${toggleClass} toggle-icon"></i>
      </summary>
      <div class="banner-content">${contentHtml}</div>
    </details>
  `;
};

export const formatToolUse = (
  normalizedPayload: { structured?: unknown },
  logId: string,
  groupId: string | undefined,
  timestamp?: number,
): string | null => {
  const normalizedToolLog = normalizeToolUseLog(normalizedPayload?.structured);
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
    isError,
  } = normalizedToolLog;

  const showAsError = isError && !isUserFeedback;
  const iconClass = isUserFeedback
    ? 'codicon-comment'
    : getToolIconClass(toolName, showAsError);

  const titlePrefix = getToolTitlePrefix(isUserFeedback, showAsError);
  const isNormalToolUse = !isUserFeedback && !showAsError;
  const titleBase = toolName
    ? isNormalToolUse
      ? toolName
      : `${titlePrefix}: ${toolName}`
    : titlePrefix;
  const headerSummary = (parsed.summary as string) || '';
  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  const sections: string[] = [];
  const filePath =
    typeof input === 'object' && input !== null && 'path' in input
      ? String((input as { path?: string }).path)
      : '';

  if (
    TOOLS_WITH_DIFF_INPUT.has(toolName) &&
    typeof (input as { old_str?: string }).old_str === 'string' &&
    typeof (input as { new_str?: string }).new_str === 'string'
  ) {
    sections.push(
      buildToolUseSection(
        'Input:',
        buildEditDiffSection(
          (input as { old_str?: string }).old_str ?? '',
          (input as { new_str?: string }).new_str ?? '',
        ),
      ),
    );
  } else if (TOOLS_WITH_FILE_LINK.has(toolName) && filePath) {
    sections.push(buildToolSection('Input:', filePath, { toolName }));
  } else if (TOOLS_WITH_FILE_CONTENT.has(toolName) && filePath) {
    const fileContent = stringifyWithLanguage(input).text;
    const language = getLanguageFromPath(filePath);
    sections.push(
      buildToolSection('Input:', fileContent, {
        toolName,
        language,
        extraClass: 'tool-use-section--input',
      }),
    );
  } else {
    const { text: inputText, language } = stringifyWithLanguage(input);
    sections.push(
      buildToolSection('Input:', inputText, { toolName, language }),
    );
  }

  if (userInstructionText) {
    sections.push(
      buildToolUseSection(
        'User Feedback:',
        `<div class="tool-user-feedback">${encodeHtml(userInstructionText)}</div>`,
      ),
    );
  }

  if (errorText) {
    sections.push(
      buildToolUseSection(
        'Error:',
        `<div class="tool-error-content">${encodeHtml(errorText)}</div>`,
      ),
    );
  }

  const { isCodeOnly, code } = extractCodeOnlyInput(outputText);
  const { text: outputTextString, language: outputLanguage } =
    stringifyWithLanguage(outputText);

  if (outputTextString || isCodeOnly) {
    if (TOOLS_WITH_FILE_LINK.has(toolName) && filePath) {
      sections.push(
        buildToolUseSection('Output:', buildFileLinkWithLines(filePath)),
      );
    } else {
      const toolLanguage = TOOL_OUTPUT_LANGUAGES.get(toolName);
      const highlightLanguage = toolLanguage || outputLanguage;
      const outputContent = isCodeOnly ? code : outputTextString;
      sections.push(
        buildToolSection('Output:', outputContent, {
          toolName,
          language: highlightLanguage,
          extraClass: 'tool-output-full',
        }),
      );
    }
  }

  return buildToolDetails({
    logId,
    groupId,
    timestamp,
    iconClass,
    title: titleText,
    contentHtml: sections.join(''),
    open: false,
    classes: [
      showAsError ? 'tool-use-error' : '',
      isUserFeedback ? 'tool-use-user-feedback' : '',
    ].filter(Boolean),
  });
};

export const formatWebSearch = (
  normalizedPayload: { structured?: Record<string, unknown> },
  logId: string,
  groupId: string | undefined,
  timestamp?: number,
): string | null => {
  const payload = normalizedPayload?.structured ?? {};
  const provider = String(payload.provider || '');
  const status = String(payload.status || '');
  const query = String(payload.query || payload.searchQuery || '');

  if (!query) return null;

  const providerLabel = PROVIDER_LABELS[provider] || provider || 'Web Search';
  const statusSuffix = STATUS_SUFFIXES[status] || '';
  const iconClass = STATUS_ICONS[status] || 'codicon codicon-globe';

  const title = `${providerLabel} Search${statusSuffix}`;
  const content = wrapInPre(query);

  return buildToolDetails({
    logId,
    groupId,
    timestamp,
    iconClass,
    title,
    contentHtml: buildToolUseSection('Query:', content),
    open: false,
  });
};

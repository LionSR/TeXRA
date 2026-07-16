/**
 * Tool-style formatters for tool use and web search messages.
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates
 * with indentation will render with unwanted spaces in the output. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 *
 * The section builders and web-search/web-fetch formatters live in
 * `./toolFormatters/`; this file owns `formatToolUseTemplate` and is the
 * public entry point so existing import paths keep working.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared utilities
import type { LogMessageData } from '@shared/schemas';
import { normalizeToolUseData } from '@shared/toolUse';
import {
  DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  DELEGATION_TOOL_CATEGORY,
} from '@shared/constants/delegationTools';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { isObject } from '@utils/core';
import { truncateSummary } from '@utils/text/stringUtils';

// Local imports - Lit template utilities
import {
  html,
  nothing,
  classMap,
  type TemplateResult,
  type FormatResult,
} from '../litTemplates';

// Local imports - formatter helpers
import {
  buildToolUseSection,
  wrapInPre,
  getToolIconName,
  buildCodeBlock,
  buildDetailsSummary,
  stopSummaryToggleKeydown,
  SPINNER_ICON_NAME,
} from '../htmlBuilders';
import { registerProposalInput } from '../proposalInputStore';
import { stringifyWithLanguage } from '../parseUtils';
import { TOOL_LABEL_MAP, TRIVIAL_WRITE_OUTPUT } from '../constants';

import {
  buildBannerContent,
  buildTerminalSection,
  buildToolSection,
  getToolTimeoutMs,
  joinWithSeparator,
  truncateHeaderSummary,
  EXECUTIONS_DEFAULT_ACTION,
} from './toolFormatters/helpers';
import { dispatchToolSections } from './toolFormatters/toolSections';

export {
  formatWebSearchTemplate,
  formatWebFetchTemplate,
} from './toolFormatters/webFormatters';

/** Format tool use log entry as TemplateResult. */
export function formatToolUseTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { timestamp, data } = message;
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
    status,
  } = normalizedToolLog;

  // Determine display state
  const isInProgress = status === 'in_progress';
  const showAsError = normalizedToolLog.isError && !isUserFeedback;
  let iconName: string;
  if (isUserFeedback) {
    iconName = 'comment';
  } else if (isInProgress) {
    iconName = SPINNER_ICON_NAME;
  } else {
    iconName = getToolIconName(toolName, showAsError);
  }

  const titleBase = toolName.startsWith('mcp:')
    ? `MCP ${toolName.slice(4)}`
    : (TOOL_LABEL_MAP[toolName] ?? toolName) || 'tool';

  // Surface action + path for executions tool so it's visible without expanding
  let headerSummary = normalizedToolLog.headerSummary || '';
  if (!headerSummary) {
    if (toolName === 'executions' && isObject(input)) {
      headerSummary =
        `${input.action ?? EXECUTIONS_DEFAULT_ACTION} ${input.path ?? ''}`.trim();
    } else if (
      toolName === 'codex' &&
      isObject(input) &&
      typeof input.prompt === 'string'
    ) {
      headerSummary = truncateSummary(input.prompt, 60);
    } else if (
      toolName === 'bash' &&
      isObject(input) &&
      typeof input.command === 'string'
    ) {
      headerSummary = truncateSummary(input.command, 60);
    }
  }
  headerSummary = truncateHeaderSummary(headerSummary, 120);
  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  const filePath =
    isObject(input) && typeof input.path === 'string' ? input.path : '';

  const sections: TemplateResult[] = dispatchToolSections({
    toolName,
    input,
    filePath,
    parsedOutput: parsed.output,
    outputText,
  });

  // Show output if present
  const isWriteTool = toolDisplayKind(toolName) === 'write';
  const isTrivialWriteOutput =
    isWriteTool && outputText.trim() === TRIVIAL_WRITE_OUTPUT;
  if (
    outputText &&
    toolName !== DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME &&
    !toolName.startsWith('mcp:') &&
    toolDisplayKind(toolName) !== 'read' &&
    !isTrivialWriteOutput
  ) {
    sections.push(
      toolName === 'bash' || toolName === 'codex'
        ? buildTerminalSection('', outputText)
        : buildToolSection('', outputText, {
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

  // Auto-open in-progress tools so users see the command immediately
  const shouldOpen = options?.defaultOpen ?? isInProgress;
  const bannerContentTemplate = buildBannerContent(message, contentTemplate);

  // Live timer for in-progress tools, with timeout limit when available
  const toolTimeoutMs = getToolTimeoutMs(toolName, input);
  // prettier-ignore
  const timerTemplate = isInProgress ? html`<tool-timer .startTime=${timestamp} .timeoutMs=${toolTimeoutMs ?? 0}></tool-timer>` : undefined;

  // Delegation banner extras: setup link (shown in summary row)
  const isProposalBearingDelegation = Object.hasOwn(
    DELEGATION_TOOL_CATEGORY,
    toolName,
  );
  const proposalId =
    isProposalBearingDelegation && !isInProgress
      ? registerProposalInput(input, toolName)
      : null;

  // A real <button> (not a role="button" span) so wa-details' own summary
  // click handler recognizes it as interactive and skips its toggle — see
  // stopSummaryToggleKeydown for why the keydown path additionally needs an
  // explicit stopPropagation.
  // prettier-ignore
  const extraContent = html`${timerTemplate ?? nothing}${proposalId ? html`<button type="button" class="proposal-restore-link proposal-banner-setup" data-proposal-id=${proposalId} title="Setup this proposal configuration" @keydown=${stopSummaryToggleKeydown}><wa-icon library=${TEXRA_ICON_LIBRARY} name="reply" aria-hidden="true"></wa-icon> Setup</button>` : nothing}`;

  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class=${classMap({
    'banner-details': true,
    'tool-use-details': true,
    'tool-use-error': showAsError,
    'tool-use-user-feedback': isUserFeedback,
    'tool-use-in-progress': isInProgress,
  })} ?open=${shouldOpen}>${buildDetailsSummary({
    iconName,
    label: titleText,
    labelClass: 'tool-use-title',
    extraContent,
  })}${bannerContentTemplate}</wa-details>`;
}

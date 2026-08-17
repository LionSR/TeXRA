/**
 * Tool-style formatters for tool use and web search messages.
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates
 * with indentation will render with unwanted spaces in the output. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 *
 * The section builders and web-search/web-fetch formatters live in
 * `./toolFormatters/`; this file owns `formatToolUseTemplate`.
 */

// Third-party imports - Lit template utilities
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - shared utilities
import { MESSAGE_TYPES, type LogMessageOf } from '@shared/schemas';
import { normalizeToolUseForRender } from '@shared/toolUse';
import {
  DELEGATE_MULTI_AGENTS_TOOL_NAME,
  DELEGATION_TOOL_CATEGORY,
} from '@shared/constants/delegationTools';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { toolDisplayKind } from '@shared/tools/toolKind';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import {
  displayToolName,
  isMcpToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';
import {
  executionsSubagentSummary,
  type ExecutionLabels,
} from '@shared/tools/executionsDisplay';
import { isObject } from '@utils/core';
import { collapseWhitespace, truncateSummary } from '@utils/text/stringUtils';

// Local imports - formatter helpers
import {
  buildToolUseSection,
  wrapInPre,
  getToolIconName,
  buildCodeBlock,
  buildSpillArtifactButton,
  stopSummaryToggleKeydown,
  SPINNER_ICON_NAME,
} from '../htmlBuilders';
import { registerProposalInput } from '../contentStore';
import { stringifyWithLanguage } from '../parseUtils';
import { TRIVIAL_WRITE_OUTPUT } from '../constants';

import {
  buildTerminalSection,
  buildToolSection,
  buildToolUseDetails,
  getToolTimeoutMs,
  truncateHeaderSummary,
} from './toolFormatters/helpers';
import { dispatchToolSections } from './toolFormatters/toolSections';
import type { FormatResult } from '../baseLogFormatter';

/** TeXRA's native tools name the target file `path`; a delegated sub-agent's
 *  built-in Read/Write/Edit tools use Anthropic's own `file_path`. */
function inputPathOf(input: Record<string, unknown>): string {
  if (typeof input.path === 'string') return input.path;
  if (typeof input.file_path === 'string') return input.file_path;
  return '';
}

/** Format tool use log entry as TemplateResult. */
export function formatToolUseTemplate(
  message: LogMessageOf<typeof MESSAGE_TYPES.TOOL_USE>,
  options?: { executionLabels?: ExecutionLabels },
): FormatResult {
  const { timestamp, data } = message;
  const normalizedToolLog = normalizeToolUseForRender(data);
  // Malformed payloads still produce a visible failed tool row through the
  // shared fallback, instead of falling through to the default log template.
  // Keep the raw value local to this render so fallback sections can include
  // fields outside the common schema without retaining a second copy in UI
  // state.
  const parsed = data;

  const {
    toolName,
    errorText,
    outputText,
    userInstructionText,
    input,
    isUserFeedback,
    status,
    spillPath,
  } = normalizedToolLog;

  // Determine display state
  const isInProgress = status === 'in_progress';
  const showAsError = normalizedToolLog.isError && !isUserFeedback;
  const normalizedToolName = normalizeToolName(toolName);
  let iconName: TeXRAIconName | typeof SPINNER_ICON_NAME;
  if (isUserFeedback) {
    iconName = 'comment';
  } else if (isInProgress) {
    iconName = SPINNER_ICON_NAME;
  } else {
    iconName = getToolIconName(normalizedToolName, showAsError);
  }

  const titleBase = displayToolName(toolName);

  // Surface action + path for executions tool so it's visible without expanding
  let headerSummary = normalizedToolLog.headerSummary || '';
  const labeledExecutionSummary =
    toolName === 'executions' && options?.executionLabels
      ? executionsSubagentSummary(input, options.executionLabels)
      : undefined;
  if (labeledExecutionSummary) {
    headerSummary = labeledExecutionSummary;
  }
  if (!headerSummary) {
    const inputPreview = deriveToolInputPreview(toolName, input);
    if (inputPreview) {
      headerSummary =
        toolName === 'executions'
          ? inputPreview
          : truncateSummary(inputPreview, 60);
    }
  }
  headerSummary = truncateHeaderSummary(headerSummary, 120);
  const titleText = headerSummary
    ? `${titleBase} — ${headerSummary}`
    : titleBase;

  // `file_path` is Anthropic's own field name for a delegated sub-agent's
  // built-in Read/Write/Edit tools; TeXRA's native tools use `path`.
  const filePath = isObject(input) ? inputPathOf(input) : '';

  const sections: TemplateResult[] = dispatchToolSections({
    toolName,
    input,
    filePath,
    parsedOutput: parsed.output,
    outputText,
  });

  // Show output if present
  const displayKind = toolDisplayKind(toolName);
  const isTrivialWriteOutput =
    displayKind === 'write' && outputText.trim() === TRIVIAL_WRITE_OUTPUT;
  // Skip the output section when its text is already fully shown in the
  // collapsed summary title (e.g. "Replaced 1 occurrence."). Exact match
  // against the summary only — a substring test would also suppress short
  // outputs that merely happen to appear inside the label or path.
  const normalizedOutput = collapseWhitespace(outputText).trim();
  const isOutputInTitle =
    normalizedOutput !== '' &&
    normalizedOutput === collapseWhitespace(headerSummary).trim();
  if (
    outputText &&
    !isOutputInTitle &&
    toolName !== DELEGATE_MULTI_AGENTS_TOOL_NAME &&
    !isMcpToolName(toolName) &&
    displayKind !== 'read' &&
    !isTrivialWriteOutput
  ) {
    sections.push(
      displayKind === 'bash' || normalizedToolName === 'codex'
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
      ? buildCodeBlock(stringifyWithLanguage(parsed).text, {
          language: 'yaml',
          showLanguage: true,
          showCopy: true,
        })
      : html`${sections}`;

  // Workflow scripts already have a compact live summary and can be very
  // large, so keep their source behind disclosure even while launching.
  const shouldOpen =
    isInProgress && toolName !== DELEGATE_MULTI_AGENTS_TOOL_NAME;

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
  const extraContent = html`${timerTemplate ?? nothing}${spillPath ? buildSpillArtifactButton(spillPath) : nothing}${proposalId ? html`<button type="button" class="proposal-restore-link proposal-banner-setup" data-proposal-id=${proposalId} title="Setup this proposal configuration" @keydown=${stopSummaryToggleKeydown}>${waIcon('reply')} Setup</button>` : nothing}`;

  return buildToolUseDetails({
    message,
    iconName,
    label: titleText,
    isError: showAsError,
    content: contentTemplate,
    defaultOpen: shouldOpen,
    extraClasses: {
      'tool-use-user-feedback': isUserFeedback,
      'tool-use-in-progress': isInProgress,
    },
    extraContent,
  });
}

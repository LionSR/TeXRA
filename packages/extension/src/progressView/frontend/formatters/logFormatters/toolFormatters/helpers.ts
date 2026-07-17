/**
 * Shared helpers for the tool-use, web-search, and web-fetch formatters.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates
 * with indentation render unwanted spaces. Always use single-line templates
 * with `// prettier-ignore` to prevent whitespace issues.
 */

import {
  html,
  ifDefined,
  type TemplateResult,
} from '@progressView/frontend/formatters/litTemplates';
import {
  buildToolUseSection,
  wrapInPre,
  buildCodeBlock,
} from '@progressView/frontend/formatters/htmlBuilders';
import { TOOL_OUTPUT_LANGUAGES } from '@progressView/frontend/formatters/constants';
import type { LogMessageData } from '@shared/schemas';
import {
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
} from '@shared/constants/toolDefaults';
import { isObject } from '@utils/core';
import {
  collapseWhitespace,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

// Side-effect import to register <tool-timer> custom element
import '@progressView/frontend/components/ToolTimer';
import '@progressView/frontend/components/TerminalOutput';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';

/** Known per-tool default timeouts (ms) for display in the running timer. */
const TOOL_DEFAULT_TIMEOUTS: Record<string, number> = {
  bash: BASH_TOOL_DEFAULT_TIMEOUT_MS,
  executions: EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS * 1000,
  codex: 300_000, // generous default — Codex turns can be slow
};

/**
 * Tools where the timeout only applies to a specific action value.
 * For these tools, only show the timer limit when that action is used.
 */
const TIMEOUT_GATED_BY_ACTION: Record<string, string> = {
  executions: 'wait',
};

export function getExecutionsWaitTimeoutSeconds(timeout: unknown): number {
  return typeof timeout === 'number' && Number.isFinite(timeout)
    ? Math.min(
        Math.max(timeout, EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS),
        EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
      )
    : EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS;
}

/**
 * Extract the effective timeout for a tool call from its input.
 * Returns undefined for tools without a configurable timeout.
 */
export function getToolTimeoutMs(
  toolName: string,
  input: unknown,
): number | undefined {
  const defaultTimeout = TOOL_DEFAULT_TIMEOUTS[toolName];
  if (defaultTimeout === undefined) return undefined;
  if (!isObject(input)) return defaultTimeout;

  // Some tools only have a meaningful timeout for a specific action
  const requiredAction = TIMEOUT_GATED_BY_ACTION[toolName];
  if (requiredAction && input.action !== requiredAction) return undefined;

  // Background tools return immediately — timeout timer is misleading
  if (input.run_in_background === true) return undefined;

  if (toolName === 'executions') {
    return getExecutionsWaitTimeoutSeconds(input.timeout) * 1000;
  }

  return typeof input.timeout === 'number' ? input.timeout : defaultTimeout;
}

/** Truncate tool header text without pulling streamed stdout/stderr into it. */
export function truncateHeaderSummary(text: string, maxLength: number): string {
  const oneLine = collapseWhitespace(text);
  const outputMarker = oneLine.search(/\s+<(?:stdout|stderr)>/i);
  const summary =
    outputMarker >= 0 ? oneLine.slice(0, outputMarker).trim() : oneLine;
  return truncateWithEllipsis(summary || oneLine, maxLength);
}

/** Join template sections with horizontal rule separators. */
export function joinWithSeparator(sections: TemplateResult[]): TemplateResult {
  return html`${sections.map(
    (section, i) =>
      html`${section}${
        i < sections.length - 1 ? html`<wa-divider></wa-divider>` : ''
      }`,
  )}`;
}

/** Build the banner content wrapper shared by tool-use and web-search entries. */
export function buildBannerContent(
  message: Pick<LogMessageData, 'id' | 'groupId' | 'timestamp'>,
  contentTemplate: TemplateResult,
): TemplateResult {
  const fullTimestamp = new Date(message.timestamp).toISOString();
  // prettier-ignore
  return html`<div class="banner-content log-entry-content" data-log-id=${ifDefined(message.id)} data-group-id=${ifDefined(message.groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${contentTemplate}</div>`;
}

/** Extract typed edits array from parsed tool output, if present. */
export function getOutputEdits<T>(output: unknown): T[] | undefined {
  return isObject(output) ? (output.edits as T[] | undefined) : undefined;
}

export type ToolSectionOptions = {
  toolName?: string;
  language?: string;
  extraClass?: string;
};

function toolDisplayText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/**
 * Build a tool section with appropriate code highlighting based on tool type.
 */
export function buildToolSection(
  label: string,
  text: unknown,
  options: ToolSectionOptions = {},
): TemplateResult {
  const { toolName = '', language: contentLanguage, extraClass = '' } = options;
  const displayText = toolDisplayText(text);

  // Determine language: tool config > content metadata > plaintext
  const toolLanguage = TOOL_OUTPUT_LANGUAGES.get(toolName);
  const language = toolLanguage || contentLanguage || 'plaintext';
  const shouldHighlight = language && language !== 'plaintext';

  const content = shouldHighlight
    ? buildCodeBlock(displayText, {
        language,
        className: extraClass,
        showLanguage: true,
        showCopy: true,
      })
    : wrapInPre(displayText, extraClass);

  return buildToolUseSection(label, content);
}

/** Build a read-only terminal section for shell output. */
export function buildTerminalSection(
  label: string,
  text: unknown,
): TemplateResult {
  return buildToolUseSection(
    label,
    html`<terminal-output
      class="tool-output-terminal"
      .text=${toolDisplayText(text)}
    ></terminal-output>`,
  );
}

export function isMcpTextBlock(
  block: unknown,
): block is { type: 'text'; text: string } {
  return (
    isObject(block) && block.type === 'text' && typeof block.text === 'string'
  );
}

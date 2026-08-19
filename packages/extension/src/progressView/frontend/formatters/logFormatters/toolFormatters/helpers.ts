/**
 * Shared helpers for the tool-use, web-search, and web-fetch formatters.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates
 * with indentation render unwanted spaces. Always use single-line templates
 * with `// prettier-ignore` to prevent whitespace issues.
 */

import { html, type TemplateResult } from 'lit';
import { classMap, type ClassInfo } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { TOOL_OUTPUT_LANGUAGES } from '@progressView/frontend/formatters/constants';
import {
  buildToolUseSection,
  buildDetailsSummary,
  wrapInPre,
  buildCodeBlock,
  SPINNER_ICON_NAME,
} from '@progressView/frontend/formatters/htmlBuilders';
import type { TranscriptRowBase } from '@shared/transcript';
import {
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  executionsWaitTimeoutSeconds,
} from '@shared/toolUse';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { isObject } from '@utils/core';

// Side-effect import to register <tool-timer> custom element
import '@progressView/frontend/components/ToolTimer';
import '@progressView/frontend/components/TerminalOutput';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

/**
 * Known per-tool default timeouts (ms) for display in the running timer.
 * Every entry must be a timeout the tool actually enforces: a tool with no
 * timeout belongs nowhere in this map, so its card shows a bare elapsed timer
 * rather than a limit it will never hit.
 */
const TOOL_DEFAULT_TIMEOUTS: Record<string, number> = {
  bash: BASH_TOOL_DEFAULT_TIMEOUT_MS,
  executions: EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS * 1000,
};

/**
 * Tools where the timeout only applies to a specific action value.
 * For these tools, only show the timer limit when that action is used.
 */
const TIMEOUT_GATED_BY_ACTION: Record<string, string> = {
  executions: 'wait',
};

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
    return executionsWaitTimeoutSeconds(input.timeout) * 1000;
  }

  return typeof input.timeout === 'number' ? input.timeout : defaultTimeout;
}

/**
 * Wrap formatted tool content in the collapsible banner shell shared by the
 * tool-use, web-search, and web-fetch entries. `extraClasses` and
 * `extraContent` carry the tool-use-only state flags and summary-row controls.
 */
export function buildToolUseDetails(opts: {
  row: Pick<TranscriptRowBase, 'id' | 'groupId' | 'timestamp'>;
  iconName: TeXRAIconName | typeof SPINNER_ICON_NAME;
  label: string;
  isError: boolean;
  content: TemplateResult;
  defaultOpen?: boolean;
  extraClasses?: ClassInfo;
  extraContent?: TemplateResult;
}): TemplateResult {
  const classes: ClassInfo = {
    'banner-details': true,
    'tool-use-details': true,
    'tool-use-error': opts.isError,
    ...opts.extraClasses,
  };
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class=${classMap(classes)} ?open=${opts.defaultOpen ?? false}>${buildDetailsSummary({ iconName: opts.iconName, label: opts.label, labelClass: 'tool-use-title', extraContent: opts.extraContent })}<div class="banner-content log-entry-content" data-log-id=${ifDefined(opts.row.id)} data-group-id=${ifDefined(opts.row.groupId)}>${opts.content}</div></wa-details>`;
}

type ToolSectionOptions = {
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
  const language =
    TOOL_OUTPUT_LANGUAGES.get(toolName) || contentLanguage || 'plaintext';
  const shouldHighlight = language !== 'plaintext';

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

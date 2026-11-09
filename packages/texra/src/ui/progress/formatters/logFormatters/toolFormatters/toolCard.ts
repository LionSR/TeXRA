/**
 * The tool card: the collapsible shell the tool-use and web-search entries
 * share, and the timeout its running timer counts toward.
 */

import { Predicate } from 'effect';
import { html, nothing, type TemplateResult } from 'lit';
import { classMap, type ClassInfo } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import {
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  executionsWaitTimeoutSeconds,
} from '@texra-ai/harness/transcript';
import { buildDetailsSummary } from '@ui/progress/formatters/htmlBuilders';
import type { IconName } from '@ui/wa/iconNames';
import type { TranscriptRowBase } from '@texra-ai/harness/transcript';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

/**
 * Known per-tool default timeouts (ms) for display in the running timer.
 * Every entry must be a timeout the tool actually enforces: a tool with no
 * timeout belongs nowhere in this map, so its card shows a bare elapsed timer
 * rather than a limit it will never hit. `action`, where present, is the one
 * action value the limit applies to; the tool's other actions show none.
 */
const TOOL_DEFAULT_TIMEOUTS: Record<string, { ms: number; action?: string }> = {
  bash: { ms: BASH_TOOL_DEFAULT_TIMEOUT_MS },
  executions: {
    ms: EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS * 1000,
    action: 'wait',
  },
};

/**
 * Extract the effective timeout for a tool call from its input.
 * Returns undefined for tools without a configurable timeout.
 */
export function getToolTimeoutMs(
  toolName: string,
  input: unknown,
): number | undefined {
  const spec = TOOL_DEFAULT_TIMEOUTS[toolName];
  if (spec === undefined) return undefined;
  if (!Predicate.isObject(input)) return spec.ms;

  // Some tools only have a meaningful timeout for a specific action
  if (spec.action && input.action !== spec.action) return undefined;

  // Background tools return immediately — timeout timer is misleading
  if (input.run_in_background === true) return undefined;

  if (toolName === 'executions') {
    return executionsWaitTimeoutSeconds(input.timeout) * 1000;
  }

  return typeof input.timeout === 'number' ? input.timeout : spec.ms;
}

/**
 * Wrap formatted tool content in the collapsible banner shell shared by the
 * tool-use and web-search entries. `extraClasses` and `extraContent` carry the
 * tool-use-only state flags and summary-row controls.
 */
export function buildToolUseDetails(opts: {
  row: Pick<TranscriptRowBase, 'id' | 'timestamp'>;
  iconName: IconName;
  /** Show a spinner in place of the icon. */
  running: boolean;
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
  // The failure icon is decorative and hidden from assistive technology.
  // Keep the collapsed summary's state available without adding visual noise.
  const statusText = opts.isError
    ? html`<span class="visually-hidden"> — Failed</span>`
    : nothing;
  const extraContent = html`${statusText}${opts.extraContent ?? nothing}`;
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class=${classMap(classes)} ?open=${opts.defaultOpen ?? false}>${buildDetailsSummary({ iconName: opts.iconName, running: opts.running, label: opts.label, labelClass: 'tool-use-title', extraContent })}<div class="banner-content log-entry-content" data-log-id=${ifDefined(opts.row.id)}>${opts.content}</div></wa-details>`;
}

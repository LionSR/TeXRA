/**
 * Entry point for progress-view formatters: one painter per transcript-row
 * kind.
 *
 * Membership — which rows exist at all — is decided once by
 * `projectTranscriptRow` (`@shared/transcript`). This map is exhaustive over
 * `TranscriptRowKind`, so a new row kind is a compile error here rather than a
 * row that silently never paints.
 */

// Third-party imports - Lit template utilities
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - shared transcript model
import type { TranscriptRow, TranscriptRowKind } from '@shared/transcript';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - formatter helpers
import { formatBannerContentTemplate } from './logFormatters/bannerFormatters';
import { formatCompactionActivityTemplate } from './logFormatters/compactionActivityFormatter';
import { formatContextManagementTemplate } from './logFormatters/contextManagementFormatters';
import {
  formatFileListTemplate,
  formatLatexdiffTemplate,
  formatMissingOutputsTemplate,
  formatStatisticsTemplate,
} from './logFormatters/dataFormatters';
import {
  formatDefaultLogMessageTemplate,
  formatErrorTemplate,
  formatProgressStatusTemplate,
  formatUserMessageTemplate,
} from './logFormatters/messageFormatters';
import { formatToolUseTemplate } from './logFormatters/toolFormatters';
import {
  formatWebFetchTemplate,
  formatWebSearchTemplate,
} from './logFormatters/toolFormatters/webFormatters';
import { formatWorkflowCallTemplate } from './logFormatters/workflowCallFormatter';
import type { FormatResult } from './baseLogFormatter';

type RowOf<K extends TranscriptRowKind> = Extract<TranscriptRow, { kind: K }>;

type RowFormatters = {
  [K in TranscriptRowKind]: (row: RowOf<K>) => FormatResult;
};

/** One painter per row kind. Exhaustive by construction. */
const ROW_FORMATTERS: RowFormatters = {
  assistant: formatBannerContentTemplate,
  thinking: formatBannerContentTemplate,
  scratchpad: formatBannerContentTemplate,
  user: formatUserMessageTemplate,
  error: formatErrorTemplate,
  tool: formatToolUseTemplate,
  webSearch: formatWebSearchTemplate,
  webFetch: formatWebFetchTemplate,
  fileList: formatFileListTemplate,
  missingOutputs: formatMissingOutputsTemplate,
  latexdiff: formatLatexdiffTemplate,
  statistics: formatStatisticsTemplate,
  contextManagement: formatContextManagementTemplate,
  // Context utilization is folded into the usage panel, not the transcript.
  contextState: () => null,
  progressStatus: formatProgressStatusTemplate,
  workflowTask: formatWorkflowCallTemplate,
  compactionActivity: formatCompactionActivityTemplate,
  phase: formatDefaultLogMessageTemplate,
  log: formatDefaultLogMessageTemplate,
};

/** Label a render failure by what failed to render. */
function renderLabel(row: TranscriptRow): string {
  if (row.kind !== 'tool') return row.kind;
  const toolName = row.toolUse.toolName.trim();
  return toolName ? `tool use (${toolName})` : 'tool use';
}

/** Create an error fallback template when formatting fails. */
function formatRenderError(label: string, errorMsg: string): TemplateResult {
  // prettier-ignore
  return html`<div class="log-line log-line--render-error"><span class="render-error-icon">${waIcon('triangle-exclamation')}</span><span class="render-error-text">Failed to render ${label}: ${errorMsg}</span></div>`;
}

/** Format a transcript row as a TemplateResult for direct Lit rendering. */
export function formatLogEntry(
  row: TranscriptRow,
): TemplateResult | typeof nothing {
  try {
    // Runtime lookup preserves the kind/payload correlation encoded by
    // `RowFormatters`; TypeScript cannot retain that correlation through an
    // indexed access over the full union.
    const formatter = ROW_FORMATTERS[row.kind] as (
      row: TranscriptRow,
    ) => FormatResult;
    return formatter(row) ?? nothing;
  } catch (e) {
    const label = renderLabel(row);
    console.error(`Error rendering ${label}:`, e);
    return formatRenderError(label, toErrorMessage(e));
  }
}

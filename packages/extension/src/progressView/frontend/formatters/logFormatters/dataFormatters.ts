/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Side-effect imports to register the custom elements emitted below
import '@progressView/frontend/components/ContextManagement';
import '@progressView/frontend/components/LatexdiffResults';

// Third-party imports - Lit template utilities
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared schemas and utilities
import type {
  ExtendedTokenUsageStats,
  LogMessageData,
  LogMessageOf,
} from '@shared/schemas';
import {
  MESSAGE_TYPES,
  OUTPUT_DOCUMENTS_TAG,
  parseDiffResultEntries,
} from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { formatCompactTokenCount, getBasename } from '@utils/core';
import { formatCostUsd } from '@utils/text/stringUtils';

// Local imports - formatter helpers
import {
  buildDetailsSummary,
  buildFileLinkSpan,
  buildFileListRender,
} from '../htmlBuilders';
import type { FormatResult } from '../baseLogFormatter';

/**
 * The collapsible file-list banner shared by the file-list and missing-outputs
 * entries: an icon/label summary over a `<ul>` of file rows, with optional
 * trailing content inside the same details element.
 */
function buildFileListDetails(options: {
  logId: string | undefined;
  iconName: TeXRAIconName;
  label: string;
  items: unknown;
  trailing?: unknown;
}): TemplateResult {
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details">${buildDetailsSummary({
    iconName: options.iconName,
    label: options.label,
    labelClass: 'summary-text',
  })}<ul class="file-list-content" data-log-id=${ifDefined(options.logId)}>${options.items}</ul>${options.trailing ?? ''}</wa-details>`;
}

/** Format file list entry as TemplateResult. */
export function formatFileListTemplate(
  message: LogMessageOf<typeof MESSAGE_TYPES.FILE_LIST>,
): FormatResult {
  const { id, data } = message;
  const { items, summary } = buildFileListRender(data);
  return buildFileListDetails({
    logId: id,
    iconName: 'file',
    label: summary,
    items,
  });
}

/** Render XML link template. */
function renderXmlLink(xmlFile: string): TemplateResult {
  const xmlFileName = getBasename(xmlFile);
  // prettier-ignore
  return html`<div class="xml-link-container">${waIcon('file-code')} <span>Open XML to check tag consistency:</span> ${buildFileLinkSpan(xmlFile, xmlFileName)} <span class="document-tag">(Expected &lt;${OUTPUT_DOCUMENTS_TAG}&gt; block)</span></div>`;
}

/** Format missing outputs entry as TemplateResult. */
export function formatMissingOutputsTemplate(
  message: LogMessageOf<typeof MESSAGE_TYPES.MISSING_OUTPUTS>,
): FormatResult {
  const { id, data } = message;
  const { missing, xmlFile } = data;

  // Special case: only XML link, no missing files
  if (missing.length === 0 && xmlFile) {
    return renderXmlLink(xmlFile);
  }

  // prettier-ignore
  const listItems = missing.map((f) => {
    const filePath = String(f);
    const basename = getBasename(filePath);
    return html`<li class="detail-item" title=${filePath}>${waIcon('triangle-exclamation')} ${buildFileLinkSpan(filePath, basename)}</li>`;
  });
  return buildFileListDetails({
    logId: id,
    iconName: 'triangle-exclamation',
    label: `Missing outputs (${missing.length})`,
    items: listItems,
    trailing: xmlFile ? renderXmlLink(xmlFile) : '',
  });
}

// =============================================================================
// Latexdiff Formatter
// =============================================================================

/** Format latexdiff entry as TemplateResult. */
export function formatLatexdiffTemplate(message: LogMessageData): FormatResult {
  const { id, data } = message;
  const entries = parseDiffResultEntries(data);
  if (entries.length === 0) return null;

  const aggregatedRunId = entries.find((e) => e.runId)?.runId;
  // prettier-ignore
  return html`<latexdiff-results .logId=${id} .runId=${ifDefined(aggregatedRunId)} .entries=${entries}></latexdiff-results>`;
}

// =============================================================================
// Statistics Formatter
// =============================================================================

type NumericExtendedTokenUsageStatsKey = {
  [K in keyof ExtendedTokenUsageStats]-?: NonNullable<
    ExtendedTokenUsageStats[K]
  > extends number
    ? K
    : never;
}[keyof ExtendedTokenUsageStats];

/** Configuration for a statistics field: [key, icon, label, formatter]. */
type StatFieldConfig = readonly [
  key: NumericExtendedTokenUsageStatsKey,
  icon: TeXRAIconName,
  label: string,
  formatter: (value: number) => string,
];

// Statistics field configuration
const STAT_FIELDS: readonly StatFieldConfig[] = [
  ['inputTokens', 'arrow-up', 'Input tokens', formatCompactTokenCount],
  ['outputTokens', 'arrow-down', 'Output tokens', formatCompactTokenCount],
  [
    'cacheReadInputTokens',
    'clock-rotate-left',
    'Cache hits',
    formatCompactTokenCount,
  ],
  [
    'cacheMissInputTokens',
    'cloud-arrow-up',
    'Cache misses',
    formatCompactTokenCount,
  ],
  [
    'cacheCreationInputTokens',
    'floppy-disk',
    'Cache writes',
    formatCompactTokenCount,
  ],
  ['percentageCached', 'chart-line', 'Cached %', (v) => `${v.toFixed(2)}%`],
  ['reasoningTokens', 'comments', 'Reasoning tokens', formatCompactTokenCount],
  [
    'toolUseTokens',
    'screwdriver-wrench',
    'Tool tokens',
    formatCompactTokenCount,
  ],
  ['elapsedTime', 'clock', 'Elapsed time', (v) => `${v}s`],
  ['cost', 'rocket', 'Cost', formatCostUsd],
];

/** Fixed header config for the statistics panel rendered via <context-management>. */
const STATISTICS_CONFIG = Object.freeze({
  icon: 'chart-line',
  label: 'Statistics',
  color: 'var(--wa-color-text-normal)',
});

/** Format statistics entry as TemplateResult. */
export function formatStatisticsTemplate(
  message: LogMessageOf<typeof MESSAGE_TYPES.STATISTICS>,
): FormatResult {
  const { id, data } = message;
  const stats = data;
  const items = STAT_FIELDS.filter(([key]) => stats[key] !== undefined).map(
    ([key, icon, label, formatter]) => ({
      icon,
      label,
      value: formatter(stats[key]!),
    }),
  );

  if (items.length === 0) return null;
  // prettier-ignore
  return html`<context-management .logId=${id} .items=${items} .config=${STATISTICS_CONFIG}></context-management>`;
}

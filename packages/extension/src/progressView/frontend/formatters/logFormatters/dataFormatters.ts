/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Third-party imports
import { z } from 'zod';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Side-effect imports to register the custom elements emitted below
import '@progressView/frontend/components/ContextManagement';
import '@progressView/frontend/components/LatexdiffResults';

// Third-party imports - Lit template utilities
import { html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared schemas and utilities
import {
  ExtendedTokenUsageStatsSchema,
  FileListEntrySchema,
  MissingOutputsPayloadSchema,
  parseDiffResultEntries,
  type ExtendedTokenUsageStats,
  type LogMessageData,
} from '@shared/schemas';
import { OUTPUT_DOCUMENTS_TAG } from '@shared/schemas/output';
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

/** Format file list entry as TemplateResult. */
export function formatFileListTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, data, text } = message;
  // Validate with Zod schema - renderer handles display field computation
  const parseResult = z.array(FileListEntrySchema).safeParse(data);
  const shouldOpen = options?.defaultOpen ?? false;

  // Raw fallback when parsing fails
  const renderData = parseResult.success
    ? buildFileListRender(parseResult.data)
    : undefined;
  const label = parseResult.success
    ? (renderData?.summary ?? 'Files')
    : 'Files (raw)';
  const listContent = parseResult.success
    ? (renderData?.items ?? '')
    : html`<pre>${text ?? ''}</pre>`;

  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
    iconName: 'file',
    label,
    labelClass: 'summary-text',
  })}<ul class="file-list-content" data-log-id=${ifDefined(id)}>${listContent}</ul></wa-details>`;
}

/** Render XML link template. */
function renderXmlLink(xmlFile: string) {
  const xmlFileName = getBasename(xmlFile);
  // prettier-ignore
  return html`<div class="xml-link-container">${waIcon('file-code')} <span>Open XML to check tag consistency:</span> ${buildFileLinkSpan(xmlFile, xmlFileName)} <span class="document-tag">(Expected &lt;${OUTPUT_DOCUMENTS_TAG}&gt; block)</span></div>`;
}

/** Format missing outputs entry as TemplateResult. */
export function formatMissingOutputsTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, data } = message;
  // Parse with Zod schema
  const parseResult = MissingOutputsPayloadSchema.safeParse(data);
  if (!parseResult.success) {
    return null;
  }

  const { missing, xmlFile } = parseResult.data;
  const shouldOpen = options?.defaultOpen ?? false;

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
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
    iconName: 'triangle-exclamation',
    label: `Missing outputs (${missing.length})`,
    labelClass: 'summary-text',
  })}<ul class="file-list-content" data-log-id=${ifDefined(id)}>${listItems}</ul>${xmlFile ? renderXmlLink(xmlFile) : ''}</wa-details>`;
}

// =============================================================================
// Latexdiff Formatter
// =============================================================================

/** Format latexdiff entry as TemplateResult. */
export function formatLatexdiffTemplate(
  message: LogMessageData,
  _options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, data } = message;
  const entries = parseDiffResultEntries(data);
  if (entries.length === 0) return null;

  const aggregatedRunId = entries.find((e) => e.runId)?.runId ?? '';
  // prettier-ignore
  return html`<latexdiff-results .logId=${id} .runId=${ifDefined(aggregatedRunId || undefined)} .entries=${entries}></latexdiff-results>`;
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
  message: LogMessageData,
  _options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, data } = message;
  // Use partial schema to allow missing optional fields
  const parseResult = ExtendedTokenUsageStatsSchema.partial().safeParse(data);
  if (!parseResult.success) return null;

  const stats = parseResult.data;
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

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
import { OUTPUT_DOCUMENTS_TAG } from '@shared/constants/outputProtocol';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { formatCompactTokenCount, getBasename } from '@utils/core';
import { formatCostUsd } from '@utils/text/stringUtils';

// Local imports - formatter helpers
import { buildFileListRender, buildDetailsSummary } from '../htmlBuilders';
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
  if (!parseResult.success) {
    // prettier-ignore
    return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
      iconName: 'file',
      label: 'Files (raw)',
      labelClass: 'summary-text',
    })}<ul class="file-list-content" data-log-id=${ifDefined(id)}><pre>${text ?? ''}</pre></ul></wa-details>`;
  }

  const renderData = buildFileListRender(parseResult.data);
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
    iconName: 'file',
    label: renderData?.summary ?? 'Files',
    labelClass: 'summary-text',
  })}<ul class="file-list-content" data-log-id=${ifDefined(id)}>${renderData?.items ?? ''}</ul></wa-details>`;
}

/** Render XML link template. */
function renderXmlLink(xmlFile: string) {
  const xmlFileName = getBasename(xmlFile);
  // prettier-ignore
  return html`<div class="xml-link-container"><wa-icon library=${TEXRA_ICON_LIBRARY} name="file-code" aria-hidden="true"></wa-icon> <span>Open XML to check tag consistency:</span> <span class="file-link clickable-link" data-file=${xmlFile} role="button" tabindex="0">${xmlFileName}</span> <span class="document-tag">(Expected &lt;${OUTPUT_DOCUMENTS_TAG}&gt; block)</span></div>`;
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
    return html`<li class="detail-item" title=${filePath}><wa-icon library=${TEXRA_ICON_LIBRARY} name="warning" aria-hidden="true"></wa-icon> <span class="file-link clickable-link" data-file=${filePath} role="button" tabindex="0">${basename}</span></li>`;
  });
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
    iconName: 'warning',
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
  icon: string,
  label: string,
  formatter: (value: number) => string,
];

// Statistics field configuration
const STAT_FIELDS: readonly StatFieldConfig[] = [
  ['inputTokens', 'arrow-up', 'Input tokens', formatCompactTokenCount],
  ['outputTokens', 'arrow-down', 'Output tokens', formatCompactTokenCount],
  ['cacheReadInputTokens', 'history', 'Cache hits', formatCompactTokenCount],
  [
    'cacheMissInputTokens',
    'cloud-upload',
    'Cache misses',
    formatCompactTokenCount,
  ],
  ['cacheCreationInputTokens', 'save', 'Cache writes', formatCompactTokenCount],
  ['percentageCached', 'graph-line', 'Cached %', (v) => `${v.toFixed(2)}%`],
  [
    'reasoningTokens',
    'comment-discussion',
    'Reasoning tokens',
    formatCompactTokenCount,
  ],
  ['toolUseTokens', 'tools', 'Tool tokens', formatCompactTokenCount],
  ['elapsedTime', 'clock', 'Elapsed time', (v) => `${v}s`],
  ['cost', 'rocket', 'Cost', formatCostUsd],
];

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
  return html`<statistics-panel .logId=${id} .items=${items}></statistics-panel>`;
}

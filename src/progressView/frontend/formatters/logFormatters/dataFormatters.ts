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

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Local imports - shared schemas
import {
  ExtendedTokenUsageStatsSchema,
  FileListEntrySchema,
  MissingOutputsPayloadSchema,
  parseDiffResultEntries,
  type ExtendedTokenUsageStats,
  type LogMessageData,
} from '@shared/schemas';
import { html, ifDefined, type FormatResult } from '../litTemplates';

// Local imports - formatter helpers
import { buildFileListRender, buildDetailsSummary } from '../htmlBuilders';
import { formatTokens } from '../timestampUtils';

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
    return html`<details class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
      iconClass: 'codicon-file',
      label: 'Files (raw)',
      labelClass: 'summary-text',
      includeIconClass: false,
    })}<ul class="file-list-content" data-log-id=${ifDefined(id)}><pre>${text ?? ''}</pre></ul></details>`;
  }

  const renderData = buildFileListRender(parseResult.data);
  // prettier-ignore
  return html`<details class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
    iconClass: 'codicon-file',
    label: renderData?.summary ?? 'Files',
    labelClass: 'summary-text',
    includeIconClass: false,
  })}<ul class="file-list-content" data-log-id=${ifDefined(id)}>${renderData?.items ?? ''}</ul></details>`;
}

/** Render XML link template. */
function renderXmlLink(xmlFile: string, documentTag: string | null) {
  const xmlFileName = getBasename(xmlFile);
  // prettier-ignore
  return html`<div class="xml-link-container"><i class="codicon codicon-file-code"></i> <span>Open XML to check tag consistency:</span> <span class="file-link clickable-link" data-file=${xmlFile}>${xmlFileName}</span>${documentTag ? html` <span class="document-tag">(Expected &lt;${documentTag}&gt; block)</span>` : ''}</div>`;
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

  const { missing, xmlFile, documentTag } = parseResult.data;
  const shouldOpen = options?.defaultOpen ?? false;

  // Special case: only XML link, no missing files
  if (missing.length === 0 && xmlFile) {
    return renderXmlLink(xmlFile, documentTag);
  }

  // prettier-ignore
  const listItems = missing.map((f) => {
    const filePath = String(f);
    const basename = getBasename(filePath);
    return html`<li class="detail-item" title=${filePath}><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file=${filePath}>${basename}</span></li>`;
  });
  // prettier-ignore
  return html`<details class="banner-details file-list-details" ?open=${shouldOpen}>${buildDetailsSummary({
    iconClass: 'codicon-warning',
    label: `Missing outputs (${missing.length})`,
    labelClass: 'summary-text',
    includeIconClass: false,
  })}<ul class="file-list-content" data-log-id=${ifDefined(id)}>${listItems}</ul>${xmlFile ? renderXmlLink(xmlFile, documentTag) : ''}</details>`;
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

  return html`
    <latexdiff-results
      .logId=${id}
      .runId=${ifDefined(aggregatedRunId || undefined)}
      .entries=${entries}
    ></latexdiff-results>
  `;
}

// =============================================================================
// Statistics Formatter
// =============================================================================

/** Configuration for a statistics field: [key, icon, label, formatter]. */
type StatFieldConfig = readonly [
  key: keyof ExtendedTokenUsageStats,
  icon: string,
  label: string,
  formatter: (value: number) => string,
];

// Statistics field configuration
const STAT_FIELDS: readonly StatFieldConfig[] = [
  ['inputTokens', 'codicon-arrow-up', 'Input tokens', formatTokens],
  ['outputTokens', 'codicon-arrow-down', 'Output tokens', formatTokens],
  ['cacheReadInputTokens', 'codicon-history', 'Cache hits', formatTokens],
  ['cacheCreationInputTokens', 'codicon-save', 'Cache writes', formatTokens],
  [
    'percentageCached',
    'codicon-graph-line',
    'Cached %',
    (v) => `${v.toFixed(2)}%`,
  ],
  [
    'reasoningTokens',
    'codicon-comment-discussion',
    'Reasoning tokens',
    formatTokens,
  ],
  ['toolUseTokens', 'codicon-tools', 'Tool tokens', formatTokens],
  ['elapsedTime', 'codicon-clock', 'Elapsed time', (v) => `${v}s`],
  ['cost', 'codicon-rocket', 'Cost', (v) => `$${v.toFixed(3)}`],
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

  return html`
    <statistics-panel .logId=${id} .items=${items}></statistics-panel>
  `;
}

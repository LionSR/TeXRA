/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 * Uses Lit templates for declarative DOM construction.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - Lit template utilities

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Local imports - shared schemas
import {
  ExtendedTokenUsageStatsSchema,
  FileListEntrySchema,
  MissingOutputsPayloadSchema,
  parseDiffResultEntries,
  type ExtendedTokenUsageStats,
} from '@shared/schemas';
import { html, ifDefined, renderToElement } from '../litTemplates';

// Local imports - formatter helpers
import { buildFileListRender, buildDetailsSummary } from '../htmlBuilders';
import { formatTokens } from '../timestampUtils';

/** Format file list entry. */
export function formatFileList(
  data: unknown,
  text: string,
  logId: string,
): HTMLElement | null {
  // Validate with Zod schema - renderer handles display field computation
  const parseResult = z.array(FileListEntrySchema).safeParse(data);

  // Raw fallback when parsing fails
  if (!parseResult.success) {
    return renderToElement(html`
      <details class="banner-details file-list-details">
        ${buildDetailsSummary({
          iconClass: 'codicon-file',
          label: 'Files (raw)',
          labelClass: 'summary-text',
          includeIconClass: false,
        })}
        <ul class="file-list-content" data-log-id=${ifDefined(logId)}>
          <pre>${text ?? ''}</pre>
        </ul>
      </details>
    `);
  }

  const renderData = buildFileListRender(parseResult.data);

  return renderToElement(html`
    <details class="banner-details file-list-details">
      ${buildDetailsSummary({
        iconClass: 'codicon-file',
        label: renderData?.summary ?? 'Files',
        labelClass: 'summary-text',
        includeIconClass: false,
      })}
      <ul class="file-list-content" data-log-id=${ifDefined(logId)}>
        ${renderData?.items ?? ''}
      </ul>
    </details>
  `);
}

/** Render XML link template. */
function renderXmlLink(xmlFile: string, documentTag: string | null) {
  const xmlFileName = getBasename(xmlFile);
  // prettier-ignore
  return html`<div class="xml-link-container"><i class="codicon codicon-file-code"></i> <span>Open XML to check tag consistency:</span> <span class="file-link clickable-link" data-file=${xmlFile}>${xmlFileName}</span>${documentTag ? html` <span class="document-tag">(Expected &lt;${documentTag}&gt; block)</span>` : ''}</div>`;
}

/** Format missing outputs entry. */
export function formatMissingOutputs(
  data: unknown,
  logId: string,
): HTMLElement | null {
  // Parse with Zod schema
  const parseResult = MissingOutputsPayloadSchema.safeParse(data);
  if (!parseResult.success) {
    return null;
  }

  const { missing, xmlFile, documentTag } = parseResult.data;

  // Special case: only XML link, no missing files
  if (missing.length === 0 && xmlFile) {
    return renderToElement(renderXmlLink(xmlFile, documentTag));
  }

  return renderToElement(html`
    <details class="banner-details file-list-details">
      ${buildDetailsSummary({
        iconClass: 'codicon-warning',
        label: `Missing outputs (${missing.length})`,
        labelClass: 'summary-text',
        includeIconClass: false,
      })}
      <ul class="file-list-content" data-log-id=${ifDefined(logId)}>
        ${missing.map((f) => {
          const filePath = String(f);
          const basename = getBasename(filePath);
          // prettier-ignore
          return html`<li class="detail-item" title=${filePath}><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file=${filePath}>${basename}</span></li>`;
        })}
      </ul>
      ${xmlFile ? renderXmlLink(xmlFile, documentTag) : ''}
    </details>
  `);
}

// =============================================================================
// Latexdiff Formatter
// =============================================================================

/** Format latexdiff entry using Lit-native component. */
export function formatLatexdiff(
  data: unknown,
  logId: string,
): HTMLElement | null {
  const entries = parseDiffResultEntries(data);
  if (entries.length === 0) return null;

  const aggregatedRunId = entries.find((e) => e.runId)?.runId ?? '';

  const element = document.createElement('latexdiff-results');
  element.setAttribute('logId', logId);
  if (aggregatedRunId) {
    element.setAttribute('runId', aggregatedRunId);
  }
  // Pass entries as property since it's an array
  (element as HTMLElement & { entries: typeof entries }).entries = entries;
  return element;
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

/** Format statistics entry using Lit-native component. */
export function formatStatistics(
  data: unknown,
  logId: string,
): HTMLElement | null {
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

  const element = document.createElement('statistics-panel');
  element.setAttribute('logId', logId);
  // Pass items as property since it's an array
  (element as HTMLElement & { items: typeof items }).items = items;
  return element;
}

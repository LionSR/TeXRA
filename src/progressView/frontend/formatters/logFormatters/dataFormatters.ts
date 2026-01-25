/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 * Uses Lit templates for declarative DOM construction.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - Lit template utilities
import { html, ifDefined, unsafeHTML, renderToElement } from '../litTemplates';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Local imports - shared schemas
import {
  FileListEntrySchema,
  MissingOutputsPayloadSchema,
  parseDiffResultEntries,
  type DiffResultDisplay,
  type DiffStatus,
} from '@shared/schemas';

// Local imports - formatter helpers
import { buildFileLink, buildFileListRender } from '../htmlBuilders';
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
        <summary class="details-summary">
          <i class="toggle-icon"></i>
          <i class="codicon codicon-file"></i>
          <span class="summary-text">Files (raw)</span>
        </summary>
        <ul
          class="file-list-content"
          data-log-id=${ifDefined(logId || undefined)}
        >
          <pre>${text ?? ''}</pre>
        </ul>
      </details>
    `);
  }

  const renderData = buildFileListRender(parseResult.data);

  return renderToElement(html`
    <details class="banner-details file-list-details">
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class="codicon codicon-file"></i>
        <span class="summary-text">${renderData?.summary ?? 'Files'}</span>
      </summary>
      <ul
        class="file-list-content"
        data-log-id=${ifDefined(logId || undefined)}
      >
        ${unsafeHTML(renderData?.items ?? '')}
      </ul>
    </details>
  `);
}

/** Render XML link template. */
function renderXmlLink(xmlFile: string, documentTag: string | null) {
  const xmlFileName = getBasename(xmlFile);
  return html`
    <div class="xml-link-container">
      <i class="codicon codicon-file-code"></i>
      <span>Open XML to check tag consistency:</span>
      <span class="file-link clickable-link" data-file=${xmlFile}
        >${xmlFileName}</span
      >
      ${documentTag
        ? html`<span class="document-tag"
            >(Expected &lt;${documentTag}&gt; block)</span
          >`
        : ''}
    </div>
  `;
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
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class="codicon codicon-warning"></i>
        <span class="summary-text">Missing outputs (${missing.length})</span>
      </summary>
      <ul
        class="file-list-content"
        data-log-id=${ifDefined(logId || undefined)}
      >
        ${missing.map((f) => {
          const filePath = String(f);
          const basename = getBasename(filePath);
          return html`
            <li class="detail-item" title=${filePath}>
              <i class="codicon codicon-warning"></i>
              <span class="file-link clickable-link" data-file=${filePath}
                >${basename}</span
              >
            </li>
          `;
        })}
      </ul>
      ${xmlFile ? renderXmlLink(xmlFile, documentTag) : ''}
    </details>
  `);
}

// =============================================================================
// Latexdiff Helpers
// =============================================================================

/** Status icon class lookup for latexdiff entries. */
const LATEXDIFF_STATUS_ICONS: Record<DiffStatus, string> = {
  success: 'codicon-check',
  error: 'codicon-error',
};

/** Get status icon class for latexdiff entry. */
const getLatexdiffStatusIcon = (status: DiffStatus): string =>
  LATEXDIFF_STATUS_ICONS[status];

/**
 * Build HTML for a latexdiff entry from validated display data.
 */
const buildLatexdiffEntryHtml = (entry: DiffResultDisplay): string => {
  const {
    baseFile,
    revisedFile,
    diffFile,
    displayName,
    baseRound,
    revisedRound,
    status,
    message,
    runId,
  } = entry;

  const icon = getLatexdiffStatusIcon(status);
  const titleAttr = message ? ` title="${message}"` : '';
  const runAttr = runId ? ` data-run-id="${runId}"` : '';

  // Build display: "essay.tex → [r0] (diff)" or "essay.tex [r0] → [r1] (diff)"
  const baseLabel =
    baseRound === null ? displayName : `${displayName} [r${baseRound}]`;
  const revisedLabel = `[r${revisedRound}]`;

  const baseLink = buildFileLink(baseFile, baseLabel);
  const revisedLink = buildFileLink(revisedFile, revisedLabel);
  const diffLink = buildFileLink(diffFile, 'diff');

  return (
    `<li class="detail-item"${runAttr}>` +
    `<i class="codicon ${icon}"${titleAttr}></i> ` +
    `${baseLink} <span class="arrow">&rarr;</span> ${revisedLink} (${diffLink})` +
    `</li>`
  );
};

// =============================================================================
// Latexdiff Formatter
// =============================================================================

/** Format latexdiff entry using Zod schema validation. */
export function formatLatexdiff(
  data: unknown,
  logId: string,
): HTMLElement | null {
  // Parse and validate with Zod - handles both new and legacy formats
  const entries = parseDiffResultEntries(data);
  if (entries.length === 0) return null;

  // Build HTML and collect first runId
  const aggregatedRunId = entries.find((e) => e.runId)?.runId ?? '';
  const items = entries.map(buildLatexdiffEntryHtml);

  const summaryText =
    entries.length === 1
      ? 'Latexdiff result'
      : `Latexdiff results (${entries.length})`;

  return renderToElement(html`
    <details class="banner-details latexdiff-details" open>
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class="codicon codicon-diff"></i>
        <span class="summary-text">${summaryText}</span>
      </summary>
      <ul
        class="latexdiff-content"
        data-log-id=${ifDefined(logId || undefined)}
        data-run-id=${ifDefined(aggregatedRunId || undefined)}
      >
        ${unsafeHTML(items.join(''))}
      </ul>
    </details>
  `);
}

// =============================================================================
// Statistics Formatter
// =============================================================================

// Statistics field configuration: [key, icon, label, formatter]
const STAT_FIELDS: [string, string, string, (value: number) => string][] = [
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

/** Format statistics entry. */
export function formatStatistics(
  data: unknown,
  logId: string,
): HTMLElement | null {
  if (!data || typeof data !== 'object') return null;

  const typedData = data as Record<string, number>;
  const items = STAT_FIELDS.filter(([key]) => typedData[key] !== undefined).map(
    ([key, icon, label, formatter]) => ({
      icon,
      label,
      value: formatter(typedData[key]),
    }),
  );

  return renderToElement(html`
    <details class="banner-details statistics-details">
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class="codicon codicon-graph"></i>
        <span class="summary-text">Statistics</span>
      </summary>
      <div
        class="statistics-content"
        data-log-id=${ifDefined(logId || undefined)}
      >
        ${items.map(
          (item) => html`
            <span class="stat-item detail-item" title=${item.label}>
              <i class=${`codicon ${item.icon}`}></i> ${item.value}
            </span>
          `,
        )}
      </div>
    </details>
  `);
}

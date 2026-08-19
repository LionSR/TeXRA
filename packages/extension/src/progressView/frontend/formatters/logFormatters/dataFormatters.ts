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
import { OUTPUT_DOCUMENTS_TAG } from '@shared/schemas';
import type {
  FileListRow,
  LatexdiffRow,
  MissingOutputsRow,
  StatisticsRow,
} from '@shared/transcript';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

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
export function formatFileListTemplate(row: FileListRow): FormatResult {
  return buildFileListDetails({
    logId: row.id,
    iconName: 'file',
    label: row.summary,
    items: buildFileListRender(row.files, row.media),
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
  row: MissingOutputsRow,
): FormatResult {
  const { id, missing, xmlFile } = row;

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
    label: row.summary,
    items: listItems,
    trailing: xmlFile ? renderXmlLink(xmlFile) : '',
  });
}

// =============================================================================
// Latexdiff Formatter
// =============================================================================

/** Format latexdiff entry as TemplateResult. */
export function formatLatexdiffTemplate(row: LatexdiffRow): FormatResult {
  // prettier-ignore
  return html`<latexdiff-results .logId=${row.id} .runId=${ifDefined(row.runId)} .entries=${row.entries}></latexdiff-results>`;
}

// =============================================================================
// Statistics Formatter
// =============================================================================

/**
 * Icon per statistics item key. Labels, ordering, and value formatting are the
 * row's (`StatisticsRow.items`); only the glyph is this host's choice.
 */
const STAT_ICONS: Record<string, TeXRAIconName> = {
  inputTokens: 'arrow-up',
  outputTokens: 'arrow-down',
  cacheReadInputTokens: 'clock-rotate-left',
  cacheMissInputTokens: 'cloud-arrow-up',
  cacheCreationInputTokens: 'floppy-disk',
  percentageCached: 'chart-line',
  reasoningTokens: 'comments',
  toolUseTokens: 'screwdriver-wrench',
  elapsedTime: 'clock',
  cost: 'rocket',
};

/** Format statistics entry as TemplateResult. The heading is the row's
 *  (`StatisticsRow.label`); only the glyph and color are this host's. */
export function formatStatisticsTemplate(row: StatisticsRow): FormatResult {
  const items = row.items.map((item) => ({
    icon: STAT_ICONS[item.key] ?? 'chart-line',
    label: item.label,
    value: item.value,
  }));
  const config = {
    icon: 'chart-line',
    label: row.label,
    color: 'var(--wa-color-text-normal)',
  };
  // prettier-ignore
  return html`<context-management .logId=${row.id} .items=${items} .config=${config}></context-management>`;
}

/**
 * Web-search and web-fetch log-entry formatters.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 */

import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import {
  buildToolUseSection,
  wrapInPre,
  SPINNER_ICON_NAME,
} from '@progressView/frontend/formatters/htmlBuilders';
import type { FormatResult } from '@progressView/frontend/formatters/baseLogFormatter';
import type { WebFetchRow, WebSearchRow } from '@shared/transcript';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { buildToolUseDetails } from './helpers';

// Web search status-based wa-icon names; SPINNER_ICON_NAME triggers a spinner.
const STATUS_ICONS: Record<string, TeXRAIconName | typeof SPINNER_ICON_NAME> = {
  failed: 'circle-exclamation',
  in_progress: SPINNER_ICON_NAME,
};

/** Line count past which fetched page text becomes a fixed-height scroll box. */
const CONTENT_SCROLL_LINES = 20;

/** Render a sanitized destination with protocol-appropriate navigation. */
function buildWebLink(
  url: string,
  label: TemplateResult,
  accessibleLabel: string,
): TemplateResult {
  const opensNewTab = /^https?:/i.test(url);
  // prettier-ignore
  return html`<a href=${url} class="web-search-link" target=${ifDefined(opensNewTab ? '_blank' : undefined)} rel=${ifDefined(opensNewTab ? 'noopener noreferrer' : undefined)} aria-label=${ifDefined(opensNewTab ? `${accessibleLabel} (opens in a new tab)` : undefined)}>${label}</a>`;
}

function webSearchFallback(status: string): string {
  if (status === 'in_progress') return 'Search in progress';
  if (status === 'failed') return 'Unable to complete search';
  return 'Search completed';
}

function webFetchFallback(status: string | undefined, failed: boolean): string {
  if (status === 'in_progress') return 'Fetching page';
  if (failed) return 'Unable to fetch page';
  return 'Fetch completed';
}

/** Format web search results as TemplateResult. */
export function formatWebSearchTemplate(row: WebSearchRow): FormatResult {
  const searchResults = row.results;
  const resultCount = searchResults.length;
  const statusKey = row.status ?? '';
  const iconName = STATUS_ICONS[statusKey] ?? 'globe';

  // Build content sections — query is already in the label, only show sources
  const sections: TemplateResult[] = [];

  if (resultCount > 0) {
    // `r.url` is already schema-sanitized (`WebSearchPayloadItemSchema`) to
    // either a safe URL or `undefined` — never render an `<a>` without a
    // real href (an empty/missing href is not itself dangerous, but a
    // result with no safe URL should read as inert text, not a dead link).
    // prettier-ignore
    const resultItems = searchResults.map((r) => {
      const label = r.title ?? r.domain ?? r.url ?? 'Untitled result';
      const showDomain = r.domain && r.domain !== label;
      // prettier-ignore
      return html`<li class="detail-item">${waIcon('link')} ${r.url ? buildWebLink(r.url, html`<bdi dir="auto">${label}</bdi>`, label) : html`<span><bdi dir="auto">${label}</bdi></span>`}${showDomain ? html` <span class="file-source">(<bdi dir="auto">${r.domain}</bdi>)</span>` : ''}</li>`;
    });
    // prettier-ignore
    const resultsTemplate = html`<span class="file-list-summary">${resultCount} ${resultCount === 1 ? 'result' : 'results'}</span><ul class="detail-list">${resultItems}</ul>`;
    sections.push(buildToolUseSection('Sources:', resultsTemplate));
  } else if (statusKey === 'completed') {
    sections.push(
      buildToolUseSection(
        'Sources:',
        html`<span class="file-list-summary">No results found</span>`,
      ),
    );
  }

  const contentTemplate =
    sections.length > 0
      ? html`${sections}`
      : html`<pre>${webSearchFallback(statusKey)}</pre>`;

  return buildToolUseDetails({
    row,
    iconName,
    label: row.label,
    isError: row.failed,
    content: contentTemplate,
  });
}

/** Format web fetch results as TemplateResult. */
export function formatWebFetchTemplate(row: WebFetchRow): FormatResult {
  const { url, title, errorLabel, failed } = row;
  const iconName = failed ? 'circle-exclamation' : 'cloud-arrow-down';

  // Build content sections
  const sections: TemplateResult[] = [];

  if (url) {
    // prettier-ignore
    sections.push(buildToolUseSection('URL:', buildWebLink(url, html`<bdi dir="ltr">${url}</bdi>`, url)));
  }

  if (title) {
    sections.push(buildToolUseSection('Title:', wrapInPre(title)));
  }

  if (errorLabel) {
    sections.push(buildToolUseSection('Error:', wrapInPre(errorLabel)));
  }

  // The fetched text itself. The row carries it untruncated; this surface
  // hands a long one to the scroll box rather than the page.
  if (row.content) {
    sections.push(
      buildToolUseSection(
        'Content:',
        wrapInPre(
          row.content.full,
          row.content.lineCount > CONTENT_SCROLL_LINES
            ? 'tool-output-full'
            : '',
        ),
      ),
    );
  }

  const contentTemplate =
    sections.length > 0
      ? html`${sections}`
      : html`<pre>${webFetchFallback(row.status, failed)}</pre>`;

  return buildToolUseDetails({
    row,
    iconName,
    label: row.label,
    isError: failed,
    content: contentTemplate,
  });
}

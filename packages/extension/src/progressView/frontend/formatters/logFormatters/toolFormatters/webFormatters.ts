/**
 * Web-search and web-fetch log-entry formatters.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 */

import { html, type TemplateResult } from 'lit';

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
    const resultItems = searchResults.map(
      (r) => html`<li class="detail-item">${waIcon('link')} ${r.url ? html`<a href=${r.url} class="web-search-link" target="_blank" rel="noopener noreferrer">${r.title ?? r.domain ?? r.url}</a>` : html`<span class="web-search-link">${r.title ?? r.domain ?? ''}</span>`}${r.domain ? html` <span class="file-source">(${r.domain})</span>` : ''}</li>`,
    );
    // prettier-ignore
    const resultsTemplate = html`<span class="file-list-summary">Results (${resultCount})</span><ul class="detail-list">${resultItems}</ul>`;
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
      : html`<pre>Web search executed</pre>`;

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
    sections.push(buildToolUseSection('URL:', html`<a href=${url} class="web-search-link" target="_blank" rel="noopener noreferrer">${url}</a>`));
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
      : html`<pre>Web fetch executed</pre>`;

  return buildToolUseDetails({
    row,
    iconName,
    label: row.label,
    isError: failed,
    content: contentTemplate,
  });
}

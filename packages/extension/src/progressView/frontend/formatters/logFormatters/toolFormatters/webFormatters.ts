/**
 * Web-search log-entry formatter.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 */

import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import {
  buildToolUseSection,
  SPINNER_ICON_NAME,
} from '@progressView/frontend/formatters/htmlBuilders';
import type { FormatResult } from '@progressView/frontend/formatters/baseLogFormatter';
import type { WebSearchRow } from '@shared/transcript';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { pluralize } from '@utils/text/stringUtils';
import { buildToolUseDetails } from './helpers';

// Web search status-based wa-icon names; SPINNER_ICON_NAME triggers a spinner.
const STATUS_ICONS: Record<string, TeXRAIconName | typeof SPINNER_ICON_NAME> = {
  failed: 'circle-exclamation',
  in_progress: SPINNER_ICON_NAME,
};

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
    const resultsTemplate = html`<span class="file-list-summary">${resultCount} ${pluralize(resultCount, 'result', 'results')}</span><ul class="detail-list">${resultItems}</ul>`;
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

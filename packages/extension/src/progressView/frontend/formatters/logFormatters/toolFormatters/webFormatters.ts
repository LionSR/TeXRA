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
import { MESSAGE_TYPES, type LogMessageOf } from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { tryParseUrl } from '@utils/core';
import { buildToolUseDetails } from './helpers';

// Web search provider display names
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

// Web search status suffixes for title
const STATUS_SUFFIXES: Record<string, string> = {
  in_progress: ' (searching...)',
  failed: ' (failed)',
};

// Web search status-based wa-icon names; SPINNER_ICON_NAME triggers a spinner.
const STATUS_ICONS: Record<string, TeXRAIconName | typeof SPINNER_ICON_NAME> = {
  failed: 'circle-exclamation',
  in_progress: SPINNER_ICON_NAME,
};

/** Format web search results as TemplateResult. */
export function formatWebSearchTemplate(
  message: LogMessageOf<typeof MESSAGE_TYPES.WEB_SEARCH>,
): FormatResult {
  const { data } = message;
  const { query, results, provider, status } = data;
  const searchResults = results ?? [];
  const resultCount = searchResults.length;
  const statusKey = status ?? '';

  const providerLabel = PROVIDER_LABELS[provider ?? 'web'] ?? 'Web';
  const statusSuffix = STATUS_SUFFIXES[statusKey] ?? '';
  const iconName = STATUS_ICONS[statusKey] ?? 'globe';

  let titleText = `${providerLabel} Search`;
  if (query) titleText += `: "${query}"`;
  titleText += statusSuffix;

  // Build content sections — query is already in the title, only show sources
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
    message,
    iconName,
    label: titleText,
    isError: statusKey === 'failed',
    content: contentTemplate,
  });
}

// Web fetch error code display labels
const FETCH_ERROR_LABELS: Record<string, string> = {
  invalid_tool_input: 'Invalid URL format',
  url_too_long: 'URL exceeds maximum length',
  url_not_allowed: 'URL blocked by domain filter',
  url_not_accessible: 'Failed to access URL',
  unsupported_content_type: 'Unsupported content type',
  too_many_requests: 'Rate limit exceeded',
  max_uses_exceeded: 'Maximum fetch uses exceeded',
  unavailable: 'Service unavailable',
};

/** Format web fetch results as TemplateResult. */
export function formatWebFetchTemplate(
  message: LogMessageOf<typeof MESSAGE_TYPES.WEB_FETCH>,
): FormatResult {
  const { data } = message;
  const { url, title, status, errorCode } = data;
  const isFailed = status === 'failed';

  const iconName = isFailed ? 'circle-exclamation' : 'cloud-arrow-down';

  let titleText = 'Web Fetch';
  if (url) {
    titleText += `: ${tryParseUrl(url)?.hostname ?? url}`;
  }
  if (isFailed) titleText += ' (failed)';

  // Build content sections
  const sections: TemplateResult[] = [];

  if (url) {
    // prettier-ignore
    sections.push(buildToolUseSection('URL:', html`<a href=${url} class="web-search-link" target="_blank" rel="noopener noreferrer">${url}</a>`));
  }

  if (title) {
    sections.push(buildToolUseSection('Title:', wrapInPre(title)));
  }

  if (isFailed && errorCode) {
    const errorLabel = FETCH_ERROR_LABELS[errorCode] ?? errorCode;
    sections.push(buildToolUseSection('Error:', wrapInPre(errorLabel)));
  }

  const contentTemplate =
    sections.length > 0
      ? html`${sections}`
      : html`<pre>Web fetch executed</pre>`;

  return buildToolUseDetails({
    message,
    iconName,
    label: titleText,
    isError: isFailed,
    content: contentTemplate,
  });
}

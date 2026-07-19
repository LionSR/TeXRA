/**
 * Web-search and web-fetch log-entry formatters.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Always use
 * single-line templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

import { html, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

import {
  buildToolUseSection,
  wrapInPre,
  buildDetailsSummary,
  SPINNER_ICON_NAME,
} from '@progressView/frontend/formatters/htmlBuilders';
import type { FormatResult } from '@progressView/frontend/formatters/baseLogFormatter';
import {
  WebSearchPayloadSchema,
  WebFetchPayloadSchema,
  type LogMessageData,
} from '@shared/schemas';
import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';
import { tryParseUrl } from '@utils/core';
import { buildBannerContent, joinWithSeparator } from './helpers';

/** Wrap formatted tool content in the shared collapsible banner shell. */
function buildToolUseDetails(opts: {
  message: LogMessageData;
  iconName: string;
  label: string;
  isError: boolean;
  content: TemplateResult;
  defaultOpen?: boolean;
}): TemplateResult {
  const bannerContentTemplate = buildBannerContent(opts.message, opts.content);
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class=${classMap({ 'banner-details': true, 'tool-use-details': true, 'tool-use-error': opts.isError })} ?open=${opts.defaultOpen ?? false}>${buildDetailsSummary({ iconName: opts.iconName, label: opts.label, labelClass: 'tool-use-title' })}${bannerContentTemplate}</wa-details>`;
}

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
const STATUS_ICONS: Record<string, string> = {
  failed: 'error',
  in_progress: SPINNER_ICON_NAME,
};

/** Format web search results as TemplateResult. */
export function formatWebSearchTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { data } = message;
  if (!data || typeof data !== 'object') return null;

  // Parsed (not merely cast) so `WebSearchResultItemSchema` actually
  // sanitizes each result's `url` — a `javascript:`/`data:` scheme from a
  // web_search tool result must never reach the `<a href>` below.
  const { query, results, provider, status } =
    WebSearchPayloadSchema.parse(data);
  const resultCount = Array.isArray(results) ? results.length : 0;
  const providerKey = typeof provider === 'string' ? provider : 'web';
  const statusKey = typeof status === 'string' ? status : '';

  const providerLabel = PROVIDER_LABELS[providerKey] ?? 'Web';
  const statusSuffix = STATUS_SUFFIXES[statusKey] ?? '';
  const iconName = STATUS_ICONS[statusKey] ?? 'globe';

  let titleText = `${providerLabel} Search`;
  if (query) titleText += `: "${query}"`;
  titleText += statusSuffix;

  // Build content sections — query is already in the title, only show sources
  const sections: TemplateResult[] = [];

  if (resultCount > 0) {
    // `r.url` is already schema-sanitized (`WebSearchResultItemSchema`) to
    // either a safe URL or `undefined` — never render an `<a>` without a
    // real href (an empty/missing href is not itself dangerous, but a
    // result with no safe URL should read as inert text, not a dead link).
    // prettier-ignore
    const resultItems = (results ?? []).map(
      (r) => html`<li class="detail-item"><wa-icon library=${TEXRA_ICON_LIBRARY} name="link" aria-hidden="true"></wa-icon> ${r.url ? html`<a href=${r.url} class="web-search-link" target="_blank" rel="noopener noreferrer">${r.title ?? r.domain ?? r.url}</a>` : html`<span class="web-search-link">${r.title ?? r.domain ?? ''}</span>`}${r.domain ? html` <span class="file-source">(${r.domain})</span>` : ''}</li>`,
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
    sections.length === 0
      ? html`<pre>Web search executed</pre>`
      : joinWithSeparator(sections);

  return buildToolUseDetails({
    message,
    iconName,
    label: titleText,
    isError: statusKey === 'failed',
    content: contentTemplate,
    defaultOpen: options?.defaultOpen,
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
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { data } = message;
  if (!data || typeof data !== 'object') return null;

  // Parsed (not merely cast) so `WebFetchPayloadSchema` actually sanitizes
  // `url` — a `javascript:`/`data:` scheme from a web_fetch tool result must
  // never reach the `<a href>` below.
  const { url, title, status, errorCode } = WebFetchPayloadSchema.parse(data);
  const statusKey = typeof status === 'string' ? status : '';
  const isFailed = statusKey === 'failed';

  const iconName = isFailed ? 'error' : 'cloud-download';

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
    sections.length === 0
      ? html`<pre>Web fetch executed</pre>`
      : joinWithSeparator(sections);

  return buildToolUseDetails({
    message,
    iconName,
    label: titleText,
    isError: isFailed,
    content: contentTemplate,
    defaultOpen: options?.defaultOpen,
  });
}

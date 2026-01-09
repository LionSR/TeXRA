/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 */

import { createFromTemplate } from '@common/templateUtils.js';
import { encodeHtml } from '@common/htmlEncoding.js';
import { getBasename } from '@common/pathUtils.js';
import {
  buildFileListRender,
  initToggleIcon,
  buildFileLink,
} from '../htmlBuilders.js';
import {
  normalizeFileListEntries,
  normalizeMissingOutputsPayload,
  ensureLatexdiffArray,
} from '../normalizers.js';
import { formatTokens } from '../timestampUtils.js';

/**
 * Format file list entry
 * @param {object} normalizedPayload - Normalized payload
 * @param {string} logId - Log entry ID
 * @returns {HTMLElement|null} File list element or null
 */
export const formatFileList = (normalizedPayload, logId) => {
  const element = createFromTemplate('fileListDetailsTemplate');
  if (!element) return null;
  const contentElem = element.querySelector('.file-list-content');
  const summaryElem = element.querySelector('.summary-text');
  initToggleIcon(element, false);

  let parsed =
    normalizeFileListEntries(normalizedPayload?.structured) || undefined;

  if (!parsed && normalizedPayload?.decodedText) {
    try {
      const parsedJson = JSON.parse(normalizedPayload.decodedText);
      parsed = normalizeFileListEntries(parsedJson) || undefined;
    } catch (_err) {
      // Fall through to raw display
    }
  }

  if (!parsed) {
    const rawContent = normalizedPayload?.decodedText ?? '';
    if (summaryElem) summaryElem.textContent = 'Files (raw)';
    if (contentElem) {
      contentElem.innerHTML = `<pre>${encodeHtml(rawContent)}</pre>`;
      if (logId) contentElem.dataset.logId = logId;
    }
    return element;
  }

  const renderData = buildFileListRender(parsed);
  const items = renderData?.items ?? '';
  const summary = renderData?.summary ?? 'Files';

  if (summaryElem) summaryElem.textContent = summary;
  if (contentElem) {
    contentElem.innerHTML = items;
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
};

/**
 * Format missing outputs entry
 * @param {object} normalizedPayload - Normalized payload
 * @param {string} logId - Log entry ID
 * @returns {HTMLElement|null} Missing outputs element or null
 */
export const formatMissingOutputs = (normalizedPayload, logId) => {
  const element = createFromTemplate('missingOutputsDetailsTemplate');
  if (!element) return null;
  const contentElem = element.querySelector('.file-list-content');
  const summaryElem = element.querySelector('.summary-text');
  initToggleIcon(element, false);

  const parsed = normalizeMissingOutputsPayload(normalizedPayload?.structured);

  if (!parsed) {
    console.warn('Missing structured data for missing outputs log entry');
    return null;
  }

  const { missing, xmlFile, documentTag } = parsed;

  const items = missing
    .map((f) => {
      const filePath = String(f);
      const escaped = encodeHtml(filePath);
      const fileName = getBasename(filePath);
      const fileNameEscaped = encodeHtml(fileName);
      return `<li class="detail-item" title="${escaped}"><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file="${escaped}">${fileNameEscaped}</span></li>`;
    })
    .join('');

  let xmlLink = '';
  if (xmlFile) {
    const xmlEscaped = encodeHtml(xmlFile);
    const xmlFileName = getBasename(xmlFile);
    const xmlFileNameEscaped = encodeHtml(xmlFileName);
    const tagInfo = documentTag
      ? `<span class="document-tag">(Expected &lt;${encodeHtml(documentTag)}&gt; block)</span>`
      : '';
    xmlLink = `<div class="xml-link-container">
        <i class="codicon codicon-file-code"></i>
        <span>Open XML to check tag consistency:</span>
        <span class="file-link clickable-link" data-file="${xmlEscaped}">${xmlFileNameEscaped}</span>
        ${tagInfo}
      </div>`;
  }

  if (missing.length === 0 && xmlFile) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = xmlLink;
    const xmlElement = wrapper.firstElementChild;
    if (!xmlElement) {
      console.error('Failed to create XML link element from HTML:', xmlLink);
      return null;
    }
    return xmlElement;
  }

  const summary = `Missing outputs (${missing.length})`;

  if (summaryElem) summaryElem.textContent = summary;
  if (contentElem) {
    contentElem.innerHTML = items;
    if (logId) contentElem.dataset.logId = logId;
  }
  if (xmlLink && element) {
    const div = document.createElement('div');
    div.innerHTML = xmlLink;
    const xmlElement = div.firstElementChild;
    if (xmlElement) {
      element.appendChild(xmlElement);
    } else {
      console.error('Failed to create XML link element from HTML:', xmlLink);
    }
  }

  return element;
};

// =============================================================================
// Latexdiff Helpers
// =============================================================================

/**
 * Convert value to string if non-empty, otherwise return empty string
 * @param {*} value - Value to convert
 * @returns {string} String value or empty string
 */
const toStringOrEmpty = (value) =>
  typeof value === 'string' && value.length > 0 ? value : '';

/**
 * Convert value to location object if valid
 * @param {*} value - Value to convert
 * @returns {object|null} Location object or null
 */
const toLocation = (value) =>
  value && typeof value === 'object' ? value : null;

/**
 * Get display path from a location object
 * @param {object|null} location - Location object with kind and relativePath
 * @returns {string} Relative path or empty string
 */
const describeLocation = (location) => {
  if (!location) return '';
  // Trust the discriminated union - kind field is the source of truth
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath || '';
  }
  return '';
};

/**
 * Get absolute path from location or fallback
 * @param {object|null} location - Location object with absolutePath
 * @param {string} fallback - Fallback path if location is invalid
 * @returns {string} Absolute path
 */
const pickAbsolutePath = (location, fallback) => {
  if (
    location &&
    typeof location.absolutePath === 'string' &&
    location.absolutePath
  ) {
    return location.absolutePath;
  }
  return fallback;
};

/**
 * Get status icon class for latexdiff entry
 * @param {string} status - Entry status ('success', 'error', or other)
 * @returns {string} Codicon class
 */
const getLatexdiffStatusIcon = (status) => {
  if (status === 'success') return 'codicon-check';
  if (status === 'error') return 'codicon-error';
  return 'codicon-question';
};

/**
 * Build HTML for a single latexdiff entry
 * @param {object} entry - Latexdiff entry data
 * @returns {string} HTML string for the entry
 */
const buildLatexdiffEntryHtml = (entry) => {
  const locations = entry && typeof entry === 'object' ? entry.locations : null;
  const baseLocation = toLocation(locations ? locations.base : null);
  const revisedLocation = toLocation(locations ? locations.revised : null);
  const diffLocation = toLocation(locations ? locations.diff : null);

  const basePath = toStringOrEmpty(entry.basePath);
  const revisedPath = toStringOrEmpty(entry.revisedPath);
  const diffPath = toStringOrEmpty(entry.diffPath);
  const msg = toStringOrEmpty(entry.message);
  const baseLabel = toStringOrEmpty(entry.baseLabel);
  const revisedLabel = toStringOrEmpty(entry.revisedLabel);
  const runId = toStringOrEmpty(entry.runId);

  const baseFile = pickAbsolutePath(baseLocation, basePath);
  const revisedFile = pickAbsolutePath(revisedLocation, revisedPath);
  const diffFile = pickAbsolutePath(diffLocation, diffPath);

  const baseDisplayRaw =
    describeLocation(baseLocation) || baseLabel || getBasename(baseFile);
  const revisedDisplayRaw =
    describeLocation(revisedLocation) ||
    revisedLabel ||
    getBasename(revisedFile || baseFile);
  const diffDisplayRaw =
    describeLocation(diffLocation) ||
    (diffFile ? getBasename(diffFile) : '') ||
    'diff';

  const icon = getLatexdiffStatusIcon(entry.status);
  const titleAttr = msg ? ` title="${encodeHtml(msg)}"` : '';
  const runAttr = runId ? ` data-run-id="${encodeHtml(runId)}"` : '';

  const baseLink = buildFileLink(baseFile, baseDisplayRaw);
  const revisedLink = buildFileLink(revisedFile, revisedDisplayRaw);
  const diffLink = buildFileLink(diffFile, diffDisplayRaw);

  return `<li class="detail-item"${runAttr}><i class="codicon ${icon}"${titleAttr}></i> ${baseLink} <span class="arrow">&rarr;</span> ${revisedLink} (${diffLink})</li>`;
};

// =============================================================================
// Latexdiff Formatter
// =============================================================================

/**
 * Format latexdiff entry
 * @param {object} normalizedPayload - Normalized payload
 * @param {string} logId - Log entry ID
 * @returns {HTMLElement|null} Latexdiff element or null
 */
export const formatLatexdiff = (normalizedPayload, logId) => {
  const element = createFromTemplate('latexdiffDetailsTemplate');
  if (!element) return null;

  const contentElem = element.querySelector('.latexdiff-content');
  const summaryElem = element.querySelector('.summary-text');
  initToggleIcon(element, true);

  const entries = ensureLatexdiffArray(normalizedPayload?.structured);
  if (!entries || entries.length === 0) {
    return null;
  }

  // Build HTML for all entries and collect first runId
  let aggregatedRunId = '';
  const items = entries
    .map((entry) => {
      const runId = toStringOrEmpty(entry?.runId);
      if (runId && !aggregatedRunId) {
        aggregatedRunId = runId;
      }
      return buildLatexdiffEntryHtml(entry);
    })
    .join('');

  const summary =
    entries.length === 1
      ? 'Latexdiff result'
      : `Latexdiff results (${entries.length})`;

  if (summaryElem) summaryElem.textContent = summary;
  if (contentElem) {
    contentElem.innerHTML = items;
    if (logId) contentElem.dataset.logId = logId;
    if (aggregatedRunId) {
      contentElem.dataset.runId = aggregatedRunId;
    }
  }

  return element;
};

// Statistics field configuration: [key, icon, label, formatter]
const STAT_FIELDS = [
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

/**
 * Format statistics entry
 * @param {object} normalizedPayload - Normalized payload
 * @param {string} logId - Log entry ID
 * @returns {HTMLElement|null} Statistics element or null
 */
export const formatStatistics = (normalizedPayload, logId) => {
  const element = createFromTemplate('statisticsDetailsTemplate');
  if (!element) return null;
  const contentElem = element.querySelector('.statistics-content');
  initToggleIcon(element, false);

  const parsed = normalizedPayload?.structured;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const items = STAT_FIELDS.filter(([key]) => parsed[key] !== undefined).map(
    ([key, icon, label, formatter]) =>
      `<span class="stat-item detail-item" title="${label}"><i class="codicon ${icon}"></i> ${formatter(parsed[key])}</span>`,
  );

  if (contentElem) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
};

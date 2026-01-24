/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 */

import { createFromTemplate } from '../templateUtils.ts';
import { encodeHtml } from '@common/modules/htmlEncoding.js';
import { getBasename } from '@common/modules/pathUtils.js';
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
export function formatFileList(normalizedPayload, logId) {
  const element = createFromTemplate('fileListDetailsTemplate');
  if (!element) return null;

  const contentElem = element.querySelector('.file-list-content');
  const summaryElem = element.querySelector('.summary-text');
  initToggleIcon(element, false);

  // Try structured data first, then fall back to parsing decodedText
  let parsed = normalizeFileListEntries(normalizedPayload?.structured);
  if (!parsed && normalizedPayload?.decodedText) {
    try {
      parsed = normalizeFileListEntries(
        JSON.parse(normalizedPayload.decodedText),
      );
    } catch {
      // Fall through to raw display
    }
  }

  // Raw fallback when parsing fails
  if (!parsed) {
    if (summaryElem) summaryElem.textContent = 'Files (raw)';
    if (contentElem) {
      contentElem.innerHTML = `<pre>${encodeHtml(normalizedPayload?.decodedText ?? '')}</pre>`;
      if (logId) contentElem.dataset.logId = logId;
    }
    return element;
  }

  const renderData = buildFileListRender(parsed);
  if (summaryElem) summaryElem.textContent = renderData?.summary ?? 'Files';
  if (contentElem) {
    contentElem.innerHTML = renderData?.items ?? '';
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
}

/**
 * Create XML link element from file info
 * @param {string} xmlFile - XML file path
 * @param {string} documentTag - Expected document tag
 * @returns {HTMLElement|null} XML link element or null
 */
function createXmlLinkElement(xmlFile, documentTag) {
  const xmlEscaped = encodeHtml(xmlFile);
  const xmlFileName = encodeHtml(getBasename(xmlFile));
  const tagInfo = documentTag
    ? `<span class="document-tag">(Expected &lt;${encodeHtml(documentTag)}&gt; block)</span>`
    : '';

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div class="xml-link-container">
    <i class="codicon codicon-file-code"></i>
    <span>Open XML to check tag consistency:</span>
    <span class="file-link clickable-link" data-file="${xmlEscaped}">${xmlFileName}</span>
    ${tagInfo}
  </div>`;
  return wrapper.firstElementChild;
}

/**
 * Format missing outputs entry
 * @param {object} normalizedPayload - Normalized payload
 * @param {string} logId - Log entry ID
 * @returns {HTMLElement|null} Missing outputs element or null
 */
export function formatMissingOutputs(normalizedPayload, logId) {
  const parsed = normalizeMissingOutputsPayload(normalizedPayload?.structured);
  if (!parsed) {
    console.warn('Missing structured data for missing outputs log entry');
    return null;
  }

  const { missing, xmlFile, documentTag } = parsed;

  // Special case: only XML link, no missing files
  if (missing.length === 0 && xmlFile) {
    return createXmlLinkElement(xmlFile, documentTag);
  }

  const element = createFromTemplate('missingOutputsDetailsTemplate');
  if (!element) return null;

  initToggleIcon(element, false);

  const summaryElem = element.querySelector('.summary-text');
  if (summaryElem) {
    summaryElem.textContent = `Missing outputs (${missing.length})`;
  }

  const contentElem = element.querySelector('.file-list-content');
  if (contentElem) {
    contentElem.innerHTML = missing
      .map((f) => {
        const filePath = String(f);
        const escaped = encodeHtml(filePath);
        return `<li class="detail-item" title="${escaped}"><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file="${escaped}">${encodeHtml(getBasename(filePath))}</span></li>`;
      })
      .join('');
    if (logId) contentElem.dataset.logId = logId;
  }

  // Append XML link if present
  if (xmlFile) {
    const xmlElement = createXmlLinkElement(xmlFile, documentTag);
    if (xmlElement) element.appendChild(xmlElement);
  }

  return element;
}

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
 * Get display path from a location object
 * @param {object|null} location - Location object with kind and relativePath
 * @returns {string} Relative path or empty string
 */
const describeLocation = (location) => {
  if (!location) return '';
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath || '';
  }
  return '';
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
 * Extract display data from new DiffResult format.
 * @param {object} entry - DiffResult entry
 * @returns {object} Extracted fields for rendering
 */
const extractNewFormat = (entry) => {
  const { baseLocation, revised, diffLocation } = entry;
  const originalPath =
    revised.lineage?.original?.relativePath ||
    revised.lineage?.original?.absolutePath;

  return {
    baseFile: baseLocation?.absolutePath || '',
    revisedFile: revised.location?.absolutePath || '',
    diffFile: diffLocation?.absolutePath || '',
    displayName: originalPath
      ? getBasename(originalPath)
      : describeLocation(baseLocation) ||
        getBasename(baseLocation?.absolutePath || '') ||
        'unknown',
    baseRound: entry.baseRound ?? null,
    revisedRound: revised.round ?? 0,
    status: entry.status || 'error',
    message: entry.message,
    runId: entry.runId,
  };
};

/**
 * Extract round number from a label like "[r1]" or "file.tex [r2]"
 * @param {string|undefined} label - Label that might contain round info
 * @returns {number|null} Round number or null if not found
 */
const parseRoundFromLabel = (label) => {
  if (typeof label !== 'string') return null;
  const match = label.match(/\[r(\d+)\]/);
  return match ? parseInt(match[1], 10) : null;
};

/**
 * Extract display data from legacy format (locations + labels).
 * @param {object} entry - Legacy entry
 * @returns {object} Extracted fields for rendering
 */
const extractLegacyFormat = (entry) => {
  const { locations } = entry;
  const baseFile = locations.base?.absolutePath || entry.basePath || '';

  // Try to get round info from entry fields first, then parse from labels
  const baseRound =
    entry.baseRound ?? parseRoundFromLabel(entry.baseLabel) ?? null;
  const revisedRound =
    entry.revisedRound ?? parseRoundFromLabel(entry.revisedLabel) ?? 0;

  return {
    baseFile,
    revisedFile: locations.revised?.absolutePath || entry.revisedPath || '',
    diffFile: locations.diff?.absolutePath || entry.diffPath || '',
    displayName:
      entry.originalFileName ||
      entry.baseLabel?.replace(/\s*\[r\d+\]/, '') || // Strip round from label
      getBasename(baseFile) ||
      'unknown',
    baseRound,
    revisedRound,
    status: entry.status || 'error',
    message: entry.message,
    runId: entry.runId,
  };
};

/**
 * Build HTML for a latexdiff entry.
 * Handles both new format (DiffResult) and legacy format (locations + labels).
 * @param {object} entry - Latexdiff entry
 * @returns {string} HTML string for the entry
 */
const buildLatexdiffEntryHtml = (entry) => {
  if (!entry) return '';

  // Extract fields based on format - new format has revised object, legacy has locations
  let data = null;
  if (entry.revised && typeof entry.revised === 'object') {
    data = extractNewFormat(entry);
  } else if (entry.locations) {
    data = extractLegacyFormat(entry);
  }

  if (!data) return '';

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
  } = data;

  const icon = getLatexdiffStatusIcon(status);
  const msg = toStringOrEmpty(message);
  const titleAttr = msg ? ` title="${encodeHtml(msg)}"` : '';
  const runAttr = runId
    ? ` data-run-id="${encodeHtml(toStringOrEmpty(runId))}"`
    : '';

  // Build display: "essay.tex → [r0] (diff)" or "essay.tex [r0] → [r1] (diff)"
  const baseLabel =
    baseRound === null ? displayName : `${displayName} [r${baseRound}]`;
  const revisedLabel = `[r${revisedRound}]`;

  const baseLink = buildFileLink(baseFile, baseLabel);
  const revisedLink = buildFileLink(revisedFile, revisedLabel);
  const diffLink = buildFileLink(diffFile, 'diff');

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
export function formatLatexdiff(normalizedPayload, logId) {
  const entries = ensureLatexdiffArray(normalizedPayload?.structured);
  if (!entries || entries.length === 0) return null;

  const element = createFromTemplate('latexdiffDetailsTemplate');
  if (!element) return null;

  initToggleIcon(element, true);

  // Build HTML for all entries and collect first runId
  let aggregatedRunId = '';
  const items = entries.map((entry) => {
    const runId = toStringOrEmpty(entry?.runId);
    if (runId && !aggregatedRunId) {
      aggregatedRunId = runId;
    }
    return buildLatexdiffEntryHtml(entry);
  });

  const summaryElem = element.querySelector('.summary-text');
  if (summaryElem) {
    summaryElem.textContent =
      entries.length === 1
        ? 'Latexdiff result'
        : `Latexdiff results (${entries.length})`;
  }

  const contentElem = element.querySelector('.latexdiff-content');
  if (contentElem) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
    if (aggregatedRunId) contentElem.dataset.runId = aggregatedRunId;
  }

  return element;
}

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
export function formatStatistics(normalizedPayload, logId) {
  const parsed = normalizedPayload?.structured;
  if (!parsed || typeof parsed !== 'object') return null;

  const element = createFromTemplate('statisticsDetailsTemplate');
  if (!element) return null;

  initToggleIcon(element, false);

  const items = STAT_FIELDS.filter(([key]) => parsed[key] !== undefined).map(
    ([key, icon, label, formatter]) =>
      `<span class="stat-item detail-item" title="${label}"><i class="codicon ${icon}"></i> ${formatter(parsed[key])}</span>`,
  );

  const contentElem = element.querySelector('.statistics-content');
  if (contentElem) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
}

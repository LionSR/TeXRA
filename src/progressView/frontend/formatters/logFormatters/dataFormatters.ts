/**
 * Data-style formatters for file lists, missing outputs, latexdiff, and statistics.
 */

// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';
import { encodeHtml } from '@common/modules/htmlEncoding.js';
import { getBasename } from '@common/modules/pathUtils.js';
// Local imports - formatter helpers
import {
  buildFileListRender,
  initToggleIcon,
  buildFileLink,
} from '../htmlBuilders';
import {
  normalizeFileListEntries,
  normalizeMissingOutputsPayload,
  ensureLatexdiffArray,
  type NormalizedPayload,
} from '../normalizers';
import { formatTokens } from '../timestampUtils';

type DiffResultEntry = Record<string, unknown>;

/** Format file list entry. */
export function formatFileList(
  normalizedPayload: NormalizedPayload,
  logId: string,
): HTMLElement | null {
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
    if (summaryElem instanceof HTMLElement) {
      summaryElem.textContent = 'Files (raw)';
    }
    if (contentElem instanceof HTMLElement) {
      contentElem.innerHTML = `<pre>${encodeHtml(normalizedPayload?.decodedText ?? '')}</pre>`;
      if (logId) contentElem.dataset.logId = logId;
    }
    return element;
  }

  const renderData = buildFileListRender(parsed);
  if (summaryElem instanceof HTMLElement) {
    summaryElem.textContent = renderData?.summary ?? 'Files';
  }
  if (contentElem instanceof HTMLElement) {
    contentElem.innerHTML = renderData?.items ?? '';
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
}

/** Create XML link element from file info. */
function createXmlLinkElement(
  xmlFile: string,
  documentTag: string | null,
): HTMLElement | null {
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
  return wrapper.firstElementChild instanceof HTMLElement
    ? wrapper.firstElementChild
    : null;
}

/** Format missing outputs entry. */
export function formatMissingOutputs(
  normalizedPayload: NormalizedPayload,
  logId: string,
): HTMLElement | null {
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
  if (summaryElem instanceof HTMLElement) {
    summaryElem.textContent = `Missing outputs (${missing.length})`;
  }

  const contentElem = element.querySelector('.file-list-content');
  if (contentElem instanceof HTMLElement) {
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

/** Convert value to string if non-empty, otherwise return empty string. */
const toStringOrEmpty = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : '';

/** Get display path from a location object. */
const describeLocation = (location: Record<string, unknown> | null): string => {
  if (!location) return '';
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return typeof location.relativePath === 'string'
      ? location.relativePath
      : '';
  }
  return '';
};

/** Get status icon class for latexdiff entry. */
const getLatexdiffStatusIcon = (status: string): string => {
  if (status === 'success') return 'codicon-check';
  if (status === 'error') return 'codicon-error';
  return 'codicon-question';
};

/** Extract display data from new DiffResult format. */
const extractNewFormat = (entry: DiffResultEntry) => {
  const baseLocation = entry.baseLocation as
    | Record<string, unknown>
    | undefined;
  const revised = entry.revised as Record<string, unknown> | undefined;
  const diffLocation = entry.diffLocation as
    | Record<string, unknown>
    | undefined;
  const originalCandidate = (
    revised?.lineage as Record<string, unknown> | undefined
  )?.original as Record<string, unknown> | undefined;
  const originalRelative =
    typeof originalCandidate?.relativePath === 'string'
      ? originalCandidate.relativePath
      : '';
  const originalAbsolute =
    typeof originalCandidate?.absolutePath === 'string'
      ? originalCandidate.absolutePath
      : '';

  return {
    baseFile:
      typeof baseLocation?.absolutePath === 'string'
        ? baseLocation.absolutePath
        : '',
    revisedFile:
      typeof (revised?.location as Record<string, unknown>)?.absolutePath ===
      'string'
        ? ((revised?.location as Record<string, unknown>)
            .absolutePath as string)
        : '',
    diffFile:
      typeof diffLocation?.absolutePath === 'string'
        ? diffLocation.absolutePath
        : '',
    displayName:
      originalRelative || originalAbsolute
        ? getBasename(originalRelative || originalAbsolute)
        : describeLocation(baseLocation ?? null) ||
          getBasename(
            typeof baseLocation?.absolutePath === 'string'
              ? baseLocation.absolutePath
              : '',
          ) ||
          'unknown',
    baseRound: typeof entry.baseRound === 'number' ? entry.baseRound : null,
    revisedRound: typeof revised?.round === 'number' ? revised.round : 0,
    status: typeof entry.status === 'string' ? entry.status : 'error',
    message: entry.message,
    runId: entry.runId,
  };
};

/** Extract round number from a label like "[r1]" or "file.tex [r2]". */
const parseRoundFromLabel = (label: string | undefined): number | null => {
  if (typeof label !== 'string') return null;
  const match = label.match(/\[r(\d+)\]/);
  return match ? parseInt(match[1], 10) : null;
};

/** Extract display data from legacy format (locations + labels). */
const extractLegacyFormat = (entry: DiffResultEntry) => {
  const locations = entry.locations as Record<string, unknown> | undefined;
  const baseFile =
    typeof (locations?.base as Record<string, unknown>)?.absolutePath ===
    'string'
      ? ((locations?.base as Record<string, unknown>)?.absolutePath as string)
      : typeof entry.basePath === 'string'
        ? entry.basePath
        : '';

  // Try to get round info from entry fields first, then parse from labels
  const baseRound =
    (typeof entry.baseRound === 'number' ? entry.baseRound : null) ??
    parseRoundFromLabel(entry.baseLabel as string | undefined) ??
    null;
  const revisedRound =
    (typeof entry.revisedRound === 'number' ? entry.revisedRound : null) ??
    parseRoundFromLabel(entry.revisedLabel as string | undefined) ??
    0;

  return {
    baseFile,
    revisedFile:
      typeof (locations?.revised as Record<string, unknown>)?.absolutePath ===
      'string'
        ? ((locations?.revised as Record<string, unknown>)
            ?.absolutePath as string)
        : typeof entry.revisedPath === 'string'
          ? entry.revisedPath
          : '',
    diffFile:
      typeof (locations?.diff as Record<string, unknown>)?.absolutePath ===
      'string'
        ? ((locations?.diff as Record<string, unknown>)?.absolutePath as string)
        : typeof entry.diffPath === 'string'
          ? entry.diffPath
          : '',
    displayName:
      (typeof entry.originalFileName === 'string'
        ? entry.originalFileName
        : '') ||
      (entry.baseLabel as string | undefined)?.replace(/\s*\[r\d+\]/, '') || // Strip round from label
      getBasename(baseFile) ||
      'unknown',
    baseRound,
    revisedRound,
    status: typeof entry.status === 'string' ? entry.status : 'error',
    message: entry.message,
    runId: entry.runId,
  };
};

/**
 * Build HTML for a latexdiff entry.
 * Handles both new format (DiffResult) and legacy format (locations + labels).
 */
const buildLatexdiffEntryHtml = (entry: DiffResultEntry): string => {
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

/** Format latexdiff entry. */
export function formatLatexdiff(
  normalizedPayload: NormalizedPayload,
  logId: string,
): HTMLElement | null {
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
  if (summaryElem instanceof HTMLElement) {
    summaryElem.textContent =
      entries.length === 1
        ? 'Latexdiff result'
        : `Latexdiff results (${entries.length})`;
  }

  const contentElem = element.querySelector('.latexdiff-content');
  if (contentElem instanceof HTMLElement) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
    if (aggregatedRunId) contentElem.dataset.runId = aggregatedRunId;
  }

  return element;
}

// Statistics field configuration: [key, icon, label, formatter]
const STAT_FIELDS: Array<[string, string, string, (value: number) => string]> =
  [
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
  normalizedPayload: NormalizedPayload,
  logId: string,
): HTMLElement | null {
  const parsed = normalizedPayload?.structured;
  if (!parsed || typeof parsed !== 'object') return null;

  const element = createFromTemplate('statisticsDetailsTemplate');
  if (!element) return null;

  initToggleIcon(element, false);

  const typedParsed = parsed as Record<string, number>;
  const items = STAT_FIELDS.filter(
    ([key]) => typedParsed[key] !== undefined,
  ).map(
    ([key, icon, label, formatter]) =>
      `<span class="stat-item detail-item" title="${label}"><i class="codicon ${icon}"></i> ${formatter(typedParsed[key])}</span>`,
  );

  const contentElem = element.querySelector('.statistics-content');
  if (contentElem instanceof HTMLElement) {
    contentElem.innerHTML = items.join('');
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
}

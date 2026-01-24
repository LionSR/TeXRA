// Local imports
import { encodeHtml } from '../htmlEncoding';
import { getBasename } from '../pathUtils';
import {
  buildFileListRender,
  buildFileLink,
  buildDetailItem,
} from '../htmlBuilders';
import {
  normalizeFileListEntries,
  normalizeMissingOutputsPayload,
  ensureLatexdiffArray,
} from '../normalizers';
import { formatTokens } from '../timestampUtils';
import { CHEVRON_DOWN_CLASS, CHEVRON_RIGHT_CLASS } from '../constants';

const buildDetails = (options: {
  className: string;
  summaryText: string;
  contentHtml: string;
  logId?: string;
  groupId?: string;
  timestamp?: string;
  open?: boolean;
}) => {
  const {
    className,
    summaryText,
    contentHtml,
    logId,
    groupId,
    timestamp,
    open,
  } = options;
  const toggleClass = open ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS;
  const dataset = [
    logId ? ` data-log-id="${encodeHtml(logId)}"` : '',
    groupId ? ` data-group-id="${encodeHtml(groupId)}"` : '',
    timestamp ? ` data-full-timestamp="${encodeHtml(timestamp)}"` : '',
  ]
    .filter(Boolean)
    .join('');
  const openAttr = open ? ' open' : '';

  return `
    <details class="banner-details ${className}"${dataset}${openAttr}>
      <summary class="details-summary">
        <span class="summary-text">${encodeHtml(summaryText)}</span>
        <i class="${toggleClass} toggle-icon"></i>
      </summary>
      ${contentHtml}
    </details>
  `;
};

export const formatFileList = (
  normalizedPayload: { decodedText?: string; structured?: unknown },
  logId: string,
): string | null => {
  let parsed = normalizeFileListEntries(normalizedPayload?.structured);
  if (!parsed && normalizedPayload?.decodedText) {
    try {
      parsed = normalizeFileListEntries(
        JSON.parse(normalizedPayload.decodedText),
      );
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    return buildDetails({
      className: 'file-list-details',
      summaryText: 'Files (raw)',
      contentHtml: `<div class="file-list-content"><pre>${encodeHtml(
        normalizedPayload?.decodedText ?? '',
      )}</pre></div>`,
      logId,
    });
  }

  const renderData = buildFileListRender(parsed);
  const content = renderData?.items ?? '';

  return buildDetails({
    className: 'file-list-details',
    summaryText: renderData?.summary ?? 'Files',
    contentHtml: `<ul class="file-list-content">${content}</ul>`,
    logId,
  });
};

const createXmlLinkElement = (xmlFile: string, documentTag?: string | null) => {
  const xmlEscaped = encodeHtml(xmlFile);
  const xmlFileName = encodeHtml(getBasename(xmlFile));
  const tagInfo = documentTag
    ? `<span class="document-tag">(Expected &lt;${encodeHtml(
        documentTag,
      )}&gt; block)</span>`
    : '';

  return `<div class="xml-link-container">
    <i class="codicon codicon-file-code"></i>
    <span>Open XML to check tag consistency:</span>
    <span class="file-link clickable-link" data-file="${xmlEscaped}">${xmlFileName}</span>
    ${tagInfo}
  </div>`;
};

export const formatMissingOutputs = (
  normalizedPayload: { structured?: unknown },
  logId: string,
): string | null => {
  const parsed = normalizeMissingOutputsPayload(normalizedPayload?.structured);
  if (!parsed) return null;

  const { missing, xmlFile, documentTag } = parsed;

  if (missing.length === 0 && xmlFile) {
    return createXmlLinkElement(xmlFile, documentTag);
  }

  const missingItems = missing
    .map((file) => {
      const filePath = String(file);
      const escaped = encodeHtml(filePath);
      return `<li class="detail-item" title="${escaped}"><i class="codicon codicon-warning"></i> <span class="file-link clickable-link" data-file="${escaped}">${encodeHtml(
        getBasename(filePath),
      )}</span></li>`;
    })
    .join('');

  const xmlLink = xmlFile ? createXmlLinkElement(xmlFile, documentTag) : '';

  return buildDetails({
    className: 'missing-outputs-details',
    summaryText: `Missing outputs (${missing.length})`,
    contentHtml: `<div><ul class="file-list-content">${missingItems}</ul>${xmlLink}</div>`,
    logId,
  });
};

const toStringOrEmpty = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : '';

const describeLocation = (location: {
  kind?: string;
  relativePath?: string;
}) => {
  if (!location) return '';
  if (location.kind === 'workspace' || location.kind === 'runStorage') {
    return location.relativePath || '';
  }
  return '';
};

const getLatexdiffStatusIcon = (status: string) => {
  if (status === 'success') return 'codicon-check';
  if (status === 'error') return 'codicon-error';
  return 'codicon-question';
};

const parseRoundFromLabel = (label?: string): number | null => {
  if (typeof label !== 'string') return null;
  const match = label.match(/\\[r(\\d+)\\]/);
  return match ? parseInt(match[1], 10) : null;
};

const extractNewFormat = (entry: any) => {
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

const extractLegacyFormat = (entry: any) => {
  const { locations } = entry;
  const baseFile = locations.base?.absolutePath || entry.basePath || '';

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
      entry.baseLabel?.replace(/\\s*\\[r\\d+\\]/, '') ||
      getBasename(baseFile) ||
      'unknown',
    baseRound,
    revisedRound,
    status: entry.status || 'error',
    message: entry.message,
    runId: entry.runId,
  };
};

const buildLatexdiffEntryHtml = (entry: any) => {
  if (!entry) return '';

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

  const baseLabel =
    baseRound === null ? displayName : `${displayName} [r${baseRound}]`;
  const revisedLabel = `[r${revisedRound}]`;

  const baseLink = buildFileLink(baseFile, baseLabel);
  const revisedLink = buildFileLink(revisedFile, revisedLabel);
  const diffLink = buildFileLink(diffFile, 'diff');

  return `<li class="detail-item"${runAttr}><i class="codicon ${icon}"${titleAttr}></i> ${baseLink} <span class="arrow">&rarr;</span> ${revisedLink} (${diffLink})</li>`;
};

export const formatLatexdiff = (
  normalizedPayload: { structured?: unknown },
  logId: string,
): string | null => {
  const entries = ensureLatexdiffArray(normalizedPayload?.structured);
  if (!entries || entries.length === 0) return null;

  const items = entries.map((entry) => buildLatexdiffEntryHtml(entry));
  const summaryText =
    entries.length === 1
      ? 'Latexdiff result'
      : `Latexdiff results (${entries.length})`;

  return buildDetails({
    className: 'latexdiff-details',
    summaryText,
    contentHtml: `<ul class="latexdiff-content">${items.join('')}</ul>`,
    logId,
    open: true,
  });
};

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

export const formatStatistics = (
  normalizedPayload: { structured?: Record<string, number> },
  logId: string,
): string | null => {
  const parsed = normalizedPayload?.structured;
  if (!parsed || typeof parsed !== 'object') return null;

  const items = STAT_FIELDS.filter(([key]) => parsed[key] !== undefined).map(
    ([key, icon, label, formatter]) =>
      `<span class="stat-item detail-item" title="${encodeHtml(
        label,
      )}"><i class="codicon ${icon}"></i> ${formatter(parsed[key] as number)}</span>`,
  );

  return buildDetails({
    className: 'statistics-details',
    summaryText: 'Statistics',
    contentHtml: `<div class="statistics-content">${items.join('')}</div>`,
    logId,
  });
};

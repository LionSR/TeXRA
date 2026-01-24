// Local imports
import { CHEVRON_DOWN_CLASS, CHEVRON_RIGHT_CLASS } from './constants';
import { encodeHtml } from './htmlEncoding';

interface BannerEntryOptions {
  logId?: string;
  groupId?: string;
  timestamp?: string;
  iconClass?: string;
  labelText?: string;
  labelHtml?: string;
  copyTitle?: string;
  contentClass?: string;
  open?: boolean;
  extraClasses?: string[];
  contentHtml?: string;
  rawContent?: string;
  summaryExtras?: string;
  showCopy?: boolean;
}

export const buildBannerEntry = ({
  logId,
  groupId,
  timestamp,
  iconClass,
  labelText,
  labelHtml,
  copyTitle,
  contentClass,
  open = false,
  extraClasses = [],
  contentHtml = '',
  rawContent,
  summaryExtras = '',
  showCopy = true,
}: BannerEntryOptions): string => {
  const toggleClass = open ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS;
  const classes = ['banner-details', ...extraClasses].join(' ');
  const dataset = [
    logId ? ` data-log-id="${encodeHtml(logId)}"` : '',
    groupId ? ` data-group-id="${encodeHtml(groupId)}"` : '',
    timestamp ? ` data-full-timestamp="${encodeHtml(timestamp)}"` : '',
  ].join('');
  const detailsOpen = open ? ' open' : '';
  const copyDefaultTitle =
    copyTitle ||
    (labelText ? `Copy ${labelText.toLowerCase()}` : 'Copy content');
  const copyButton = showCopy
    ? `<button class="banner-content-copy" title="${encodeHtml(
        copyDefaultTitle,
      )}" data-default-title="${encodeHtml(
        copyDefaultTitle,
      )}" data-success-title="Copied!"><i class="codicon codicon-copy"></i></button>`
    : '';

  const contentAttrs = [
    contentClass ? ` ${contentClass}` : '',
    rawContent ? ` data-raw-content="${encodeHtml(rawContent)}"` : '',
  ].join('');

  return `
    <details class="${classes}"${dataset}${detailsOpen}>
      <summary class="details-summary">
        <i class="codicon icon ${iconClass ?? ''}"></i>
        <span class="label">${labelHtml ?? encodeHtml(labelText ?? '')}</span>
        ${summaryExtras}
        ${copyButton}
        <i class="${toggleClass} toggle-icon"></i>
      </summary>
      <div class="banner-content${contentAttrs}">${contentHtml}</div>
    </details>
  `;
};

export const safeFormat = <T>(
  formatter: () => T,
  errorContext: string,
): T | null => {
  try {
    return formatter();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error parsing ${errorContext}:`, error);
    return null;
  }
};

export const resolveOpenState = (
  messageType: string,
  options: { preservedOpen?: boolean; defaultOpen?: boolean } | undefined,
  autoExpandedTypes: Set<string>,
): boolean | undefined => {
  if (!options) return undefined;
  if (options.preservedOpen !== undefined) return options.preservedOpen;
  if (options.defaultOpen && autoExpandedTypes.has(messageType)) return true;
  return undefined;
};

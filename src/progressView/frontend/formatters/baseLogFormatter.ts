/**
 * Base log formatter with shared utilities for creating banner entries.
 */

// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';

// Local imports - formatter helpers
import { setElementDataset, initToggleIcon } from './htmlBuilders';

type BannerEntry = {
  element: HTMLElement;
  contentElem: HTMLElement | null;
  copyButton: HTMLElement | null;
  summaryElem: HTMLElement | null;
};

type BannerEntryOptions = {
  logId?: string;
  groupId?: string;
  timestamp?: string;
  iconClass?: string;
  labelText?: string;
  copyTitle?: string;
  contentClass?: string;
  open?: boolean;
  templateId?: string;
};

type FormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
};

/** Apply open/closed state to a details element. */
export function applyOpenState(
  element: HTMLElement,
  shouldOpen?: boolean,
): void {
  if (element instanceof HTMLDetailsElement && shouldOpen !== undefined) {
    element.open = shouldOpen;
    initToggleIcon(element, shouldOpen);
  }
}

/** Create a banner entry from template. */
export function createBannerEntry({
  logId,
  groupId,
  timestamp,
  iconClass,
  labelText,
  copyTitle,
  contentClass,
  open = false,
  templateId = 'bannerDetailsTemplate',
}: BannerEntryOptions): BannerEntry | null {
  const element = createFromTemplate(templateId);
  if (!element) return null;

  applyOpenState(element, open);
  setElementDataset(element, { logId, groupId, timestamp });

  const iconElem = element.querySelector('.icon');
  if (iconElem instanceof HTMLElement) {
    iconElem.className = 'codicon icon';
    if (iconClass) {
      iconElem.classList.add(iconClass);
      iconElem.hidden = false;
    } else {
      iconElem.hidden = true;
    }
  }

  const labelElem = element.querySelector('.label');
  if (labelElem instanceof HTMLElement) {
    labelElem.textContent = labelText ?? '';
  }

  const copyButton = element.querySelector('.banner-content-copy');
  if (copyButton) {
    const defaultTitle =
      copyTitle ||
      (labelText ? `Copy ${labelText.toLowerCase()}` : 'Copy content');
    if (copyButton instanceof HTMLElement) {
      copyButton.dataset.defaultTitle = defaultTitle;
      copyButton.dataset.successTitle = 'Copied!';
      copyButton.setAttribute('title', defaultTitle);
      copyButton.setAttribute('aria-label', defaultTitle);
    }
  }

  const contentElem = element.querySelector('.banner-content');
  if (contentElem instanceof HTMLElement && contentClass) {
    contentElem.classList.add(contentClass);
  }

  return {
    element,
    contentElem: contentElem instanceof HTMLElement ? contentElem : null,
    copyButton: copyButton instanceof HTMLElement ? copyButton : null,
    summaryElem: element.querySelector(
      '.details-summary',
    ) as HTMLElement | null,
  };
}

/** Safely execute a formatting function with error handling. */
export function safeFormat<T>(
  formatter: () => T,
  errorContext: string,
): T | null {
  try {
    return formatter();
  } catch (e) {
    console.error(`Error parsing ${errorContext}:`, e);
    return null;
  }
}

/** Resolve whether a details element should be open. */
export function resolveOpenState(
  messageType: string,
  options: FormatOptions | undefined,
  autoExpandedTypes: Set<string>,
): boolean | undefined {
  if (!options) return undefined;

  // Preserved state takes precedence
  if (options.preservedOpen !== undefined) return options.preservedOpen;

  // Auto-expand certain types when defaultOpen is set
  if (options.defaultOpen && autoExpandedTypes.has(messageType)) return true;

  return undefined;
}

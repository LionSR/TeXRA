// @ts-nocheck
/**
 * Base log formatter with shared utilities for creating banner entries.
 */

import { createFromTemplate } from '@common/modules/templateUtils.js';
import { setElementDataset, initToggleIcon } from './htmlBuilders';

/**
 * Apply open/closed state to a details element
 * @param {HTMLElement} element - Details element
 * @param {boolean} [shouldOpen] - Whether element should be open
 */
export function applyOpenState(element, shouldOpen) {
  if (
    !(element instanceof HTMLElement) ||
    element.tagName !== 'DETAILS' ||
    shouldOpen === undefined
  ) {
    return;
  }

  element.open = shouldOpen;
  initToggleIcon(element, shouldOpen);
}

/**
 * Create a banner entry from template
 * @param {object} options - Banner configuration
 * @param {string} options.logId - Log entry ID
 * @param {string} [options.groupId] - Group ID
 * @param {string} [options.timestamp] - ISO timestamp
 * @param {string} [options.iconClass] - Codicon class for icon
 * @param {string} [options.labelText] - Banner label text
 * @param {string} [options.copyTitle] - Copy button title
 * @param {string} [options.contentClass] - CSS class for content element
 * @param {boolean} [options.open=false] - Whether banner should be open
 * @param {string} [options.templateId='bannerDetailsTemplate'] - Template ID
 * @returns {{element: HTMLElement, contentElem: HTMLElement|null, copyButton: HTMLElement|null, summaryElem: HTMLElement|null}|null}
 */
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
}) {
  const element = createFromTemplate(templateId);
  if (!element) return null;

  applyOpenState(element, Boolean(open));
  setElementDataset(element, { logId, groupId, timestamp });

  const iconElem = element.querySelector('.icon');
  if (iconElem) {
    iconElem.className = 'codicon icon';
    if (iconClass) {
      iconElem.classList.add(iconClass);
      iconElem.hidden = false;
    } else {
      iconElem.hidden = true;
    }
  }

  const labelElem = element.querySelector('.label');
  if (labelElem) {
    labelElem.textContent = labelText ?? '';
  }

  const copyButton = element.querySelector('.banner-content-copy');
  if (copyButton) {
    const defaultTitle =
      copyTitle ||
      (labelText ? `Copy ${labelText.toLowerCase()}` : 'Copy content');
    copyButton.dataset.defaultTitle = defaultTitle;
    copyButton.dataset.successTitle = 'Copied!';
    copyButton.setAttribute('title', defaultTitle);
    copyButton.setAttribute('aria-label', defaultTitle);
  }

  const contentElem = element.querySelector('.banner-content');
  if (contentElem && contentClass) {
    contentElem.classList.add(contentClass);
  }

  return {
    element,
    contentElem,
    copyButton,
    summaryElem: element.querySelector('.details-summary'),
  };
}

/**
 * Safely execute a formatting function with error handling
 * @param {Function} formatter - The formatting function to execute
 * @param {string} errorContext - Context for error message
 * @returns {*} Result of formatter or null if error
 */
export function safeFormat(formatter, errorContext) {
  try {
    return formatter();
  } catch (e) {
    console.error(`Error parsing ${errorContext}:`, e);
    return null;
  }
}

/**
 * Resolve whether a details element should be open
 * @param {string} messageType - Type of message
 * @param {object} [options] - Options with preservedOpen or defaultOpen
 * @param {Set<string>} autoExpandedTypes - Set of types that auto-expand
 * @returns {boolean|undefined}
 */
export function resolveOpenState(messageType, options, autoExpandedTypes) {
  if (!options) return undefined;

  // Preserved state takes precedence
  if (options.preservedOpen !== undefined) return options.preservedOpen;

  // Auto-expand certain types when defaultOpen is set
  if (options.defaultOpen && autoExpandedTypes.has(messageType)) return true;

  return undefined;
}

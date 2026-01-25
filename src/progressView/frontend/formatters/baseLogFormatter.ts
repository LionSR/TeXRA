/**
 * Base log formatter with shared utilities for creating banner entries.
 * Uses Lit templates for declarative DOM construction.
 */

// Local imports - Lit template utilities
import { html, classMap, ifDefined, renderToElement } from './litTemplates';

// Local imports - formatter helpers
import { initToggleIcon } from './htmlBuilders';

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

/** Create a banner entry using Lit template. */
export function createBannerEntry({
  logId,
  groupId,
  timestamp,
  iconClass,
  labelText,
  copyTitle,
  contentClass,
  open = false,
}: BannerEntryOptions): BannerEntry | null {
  const defaultTitle =
    copyTitle ||
    (labelText ? `Copy ${labelText.toLowerCase()}` : 'Copy content');

  const element = renderToElement(html`
    <details class="banner-details" ?open=${open}>
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i
          class=${classMap({
            codicon: true,
            icon: true,
            [iconClass ?? '']: Boolean(iconClass),
          })}
          ?hidden=${!iconClass}
        ></i>
        <span class="label">${labelText ?? ''}</span>
        <vscode-toolbar-button
          class="banner-content-copy"
          icon="copy"
          title=${defaultTitle}
          aria-label=${defaultTitle}
          data-default-title=${defaultTitle}
          data-success-title="Copied!"
        ></vscode-toolbar-button>
      </summary>
      <div
        class=${classMap({
          'banner-content': true,
          'log-entry-content': true,
          [contentClass ?? '']: Boolean(contentClass),
        })}
        data-log-id=${ifDefined(logId)}
        data-group-id=${ifDefined(groupId)}
        data-timestamp=${ifDefined(timestamp)}
      ></div>
    </details>
  `);

  if (!element) return null;

  // Initialize toggle icon state
  initToggleIcon(element, open);

  return {
    element,
    contentElem: element.querySelector('.banner-content') as HTMLElement | null,
    copyButton: element.querySelector(
      '.banner-content-copy',
    ) as HTMLElement | null,
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

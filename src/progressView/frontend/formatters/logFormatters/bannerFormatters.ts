/**
 * Banner-style formatters for thinking, scratchpad, and model response messages.
 * Uses Lit templates with unsafeHTML for markdown content rendering.
 */

// Local imports - Lit utilities
import {
  html,
  unsafeHTML,
  classMap,
  ifDefined,
  renderToElement,
} from '../litTemplates';

// Local imports - formatter helpers
import { formatTimestamp } from '../timestampUtils';
import { processMarkdownContent } from '../markdownRenderer';
import { initToggleIcon } from '../htmlBuilders';

// Local imports - shared schemas
import type { LogLevel } from '@shared/schemas';

// Banner configuration by content type
const BANNER_CONFIG: Record<
  string,
  {
    iconClass: string;
    labelText: string;
    copyTitle: string;
    contentClass: string;
  }
> = {
  Thinking: {
    iconClass: 'codicon-lightbulb',
    labelText: 'Thinking',
    copyTitle: 'Copy thinking',
    contentClass: 'banner-content--thinking',
  },
  Scratchpad: {
    iconClass: 'codicon-pencil',
    labelText: 'Scratchpad',
    copyTitle: 'Copy scratchpad',
    contentClass: 'banner-content--scratchpad',
  },
};

/** Format thinking or scratchpad banner content. */
export function formatBannerContent(
  text: string,
  contentType: string,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const config = BANNER_CONFIG[contentType] ?? BANNER_CONFIG.Thinking;
  const { fullTimestamp } = formatTimestamp(new Date(timestamp));
  const markdownHtml = processMarkdownContent(trimmedContent);

  const template = html`
    <details
      class="banner-details"
      data-log-id=${ifDefined(logId)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class="codicon icon ${config.iconClass}"></i>
        <span class="label">${config.labelText}</span>
        <vscode-toolbar-button
          class="banner-content-copy"
          icon="copy"
          title=${config.copyTitle}
          aria-label=${config.copyTitle}
          data-default-title=${config.copyTitle}
          data-success-title="Copied!"
        ></vscode-toolbar-button>
      </summary>
      <div
        class="banner-content log-entry-content ${config.contentClass}"
        data-raw-content=${trimmedContent}
      >
        ${unsafeHTML(markdownHtml)}
      </div>
    </details>
  `;

  const element = renderToElement(template);
  if (element) initToggleIcon(element, false);
  return element;
}

/** Format a model response with markdown rendering. */
export function formatModelResponse({
  id,
  groupId,
  timestamp,
  verbose,
  text,
  level,
}: {
  id: string;
  groupId?: string;
  timestamp: number;
  verbose?: boolean;
  text: string;
  level: LogLevel;
}): HTMLElement | null {
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );
  const markdownHtml = processMarkdownContent(trimmedContent);
  const timestampText = verbose ? `[${timeDisplay}]` : '';

  const template = html`
    <details
      class="banner-details"
      open
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      <summary class="details-summary">
        <i class="toggle-icon"></i>
        <i class="codicon icon codicon-sparkle"></i>
        <span class="label">Assistant</span>
        <span class="timestamp" title=${tooltipTimestamp}
          >${timestampText}</span
        >
        <vscode-toolbar-button
          class="banner-content-copy"
          icon="copy"
          title="Copy model output"
          aria-label="Copy model output"
          data-default-title="Copy model output"
          data-success-title="Copied!"
        ></vscode-toolbar-button>
      </summary>
      <div
        class=${classMap({
          'banner-content': true,
          'log-entry-content': true,
          'banner-content--model': true,
          [`message-${level}`]: true,
        })}
        data-raw-content=${trimmedContent}
      >
        ${unsafeHTML(markdownHtml)}
      </div>
    </details>
  `;

  const element = renderToElement(template);
  if (element) initToggleIcon(element, true);
  return element;
}

// Third-party imports
import { css } from 'lit';

/**
 * Base log entry styles for log lines, banners, and common elements.
 */
export const logEntryStyles = css`
  /* Note: Component-specific :host and element layout styles should be defined
     in each component, not here. These styles are for content classes only. */

  .log-container {
    flex: 1 1 auto;
    padding: var(--wa-space-3xs) var(--wa-space-xs);
    min-width: 0;
    min-height: 0;
    font-family: var(--font-family);
    font-size: var(--font-size);
    position: relative;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .log-line {
    line-height: var(--line-height-normal);
    margin: 0;
    padding: calc(var(--wa-space-3xs) / 2) 0;
    display: block;
    white-space: pre-wrap;
    word-wrap: break-word;
    word-break: break-all;
    content-visibility: auto;
    contain-intrinsic-size: auto 24px;
  }

  .log-line--render-error {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    margin: var(--wa-space-2xs) 0;
    background: var(--wa-color-warning-fill-quiet);
    border: var(--border-thin) solid var(--wa-color-warning-border-quiet);
    border-radius: var(--border-radius);
    color: var(--color-warning);
    font-style: italic;
  }

  .log-reveal-row {
    display: flex;
    justify-content: center;
    margin: var(--wa-space-2xs) 0;
  }

  .log-reveal-button {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    min-height: 24px;
    padding: 0 var(--wa-space-xs);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius-small);
    background: var(--wa-color-surface-default);
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .log-reveal-button:hover {
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .log-reveal-button:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 2px;
  }

  .render-error-icon {
    font-style: normal;
    flex-shrink: 0;
  }

  .log-entry-content {
    padding: var(--wa-space-2xs) 0 var(--wa-space-xs) var(--wa-space-s);
    overflow: visible;
  }

  /* Light DOM formatter styles */
  .file-list-content {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .file-list-content .file-var,
  .file-list-content .file-source {
    color: var(--color-text-secondary);
  }

  .file-list-content .file-var {
    opacity: var(--opacity-normal);
    font-size: var(--font-size-sm);
    margin-left: var(--wa-space-3xs);
  }

  .file-list-content .file-source {
    opacity: var(--opacity-subtle);
    font-size: 0.85em;
    font-style: italic;
  }

  .xml-link-container {
    margin-top: var(--wa-space-2xs);
    padding-top: var(--wa-space-2xs);
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .xml-link-container wa-icon {
    opacity: var(--opacity-subtle);
  }

  .xml-link-container .document-tag {
    color: var(--color-text-secondary);
    opacity: var(--opacity-normal);
    font-style: italic;
  }

  .xml-link-container .xml-fix-hint {
    flex-basis: 100%;
    margin-top: var(--wa-space-3xs);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
  }

  .xml-link-container .xml-fix-hint wa-icon {
    opacity: var(--opacity-full);
    color: var(--color-text-link);
  }

  .xml-link-container .xml-fix-hint strong {
    color: var(--color-text-link);
  }

  /* Note: .detail-item base styles are in commonViewStyles; this adds log-specific variants */

  :is(.file-link, .web-search-link) {
    color: var(--color-text-link);
    cursor: pointer;
  }

  :is(.file-link, .web-search-link):hover {
    text-decoration: underline;
  }

  :is(.file-link, .web-search-link):focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .web-search-link {
    text-decoration: none;
  }

  .memory-path {
    color: var(--color-text-secondary);
  }

  .memory-path wa-icon {
    margin-right: var(--wa-space-2xs);
  }

  .memory-path .file-source {
    opacity: var(--opacity-subtle);
    font-size: 0.85em;
  }

  /* Web search result styles */
  .detail-list {
    list-style: none;
    margin: var(--wa-space-2xs) 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-3xs);
  }

  .file-list-summary {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
  }

  /* Note: .toggle-icon and .details-summary base styles are in commonViewStyles */

  /* File list details styling */
  .file-list-details {
    margin: var(--wa-space-2xs) 0;
  }

  .banner-content-copy {
    min-width: 0;
    padding: 0 var(--wa-space-3xs);
    opacity: 0;
    margin-left: auto;
    cursor: pointer;
  }

  .details-summary:hover .banner-content-copy,
  .banner-details:focus-within .banner-content-copy,
  .banner-content-copy:focus-visible {
    opacity: var(--opacity-full);
    outline: var(--border-thin) solid var(--wa-color-focus);
  }

  .banner-content-copy.copy-success {
    opacity: var(--opacity-full);
    color: var(--color-success);
  }

  .timestamp {
    color: var(--color-text-secondary);
  }

  /* Log level badges */
  :is(.level-debug, .level-info, .level-warn, .level-error) {
    font-weight: var(--font-weight-bold);
  }

  .level-debug {
    color: var(--wa-color-debug-name, #4b9ef9);
  }

  .level-info {
    color: var(--wa-color-icon-info, #75beff);
  }

  .level-warn,
  .message-warn {
    color: var(--color-warning);
  }

  .level-error,
  .message-error {
    color: var(--color-error);
  }

  .message-debug {
    color: var(--wa-color-text-preformat, #a9b7c6);
  }

  .message-info {
    color: var(--wa-color-text-normal);
  }

  .banner-summary {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    font-size: var(--font-size);
    font-weight: var(--font-weight-semibold);
  }

  .banner-details {
    margin: var(--wa-space-2xs) 0;
    content-visibility: auto;
    contain-intrinsic-size: auto 40px;
  }

  .banner-content {
    margin: 0;
  }

  .banner-details:not([open]) .banner-content {
    display: none;
  }

  .extract-flag {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    border-radius: var(--border-radius);
    background: var(--wa-color-neutral-fill-quiet);
    color: var(--wa-color-neutral-on-quiet);
    margin-right: var(--wa-space-2xs);
  }

  /* Terminal-style output: monospace font, tighter spacing, no log bullets.
     Applied to streams that proxy raw process output (e.g. bash child streams)
     so their stdout/stderr reads like a terminal instead of a logger. */
  :host([terminal]) .log-container {
    font-family: var(
      --wa-font-family-mono,
      ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace
    );
    font-size: var(--wa-editor-font-size, var(--font-size));
    background-color: var(
      --wa-color-terminal-background,
      var(--wa-color-surface-default, transparent)
    );
    color: var(--wa-color-terminal-foreground, var(--wa-color-text-normal));
  }

  :host([terminal]) .log-line {
    padding: 0;
    line-height: 1.35;
    word-break: normal;
    overflow-wrap: anywhere;
  }

  /* Bullet/timestamp prefix is noisy for raw process output. */
  :host([terminal]) .log-line .timestamp {
    display: none;
  }

  /* stdout renders at terminal foreground; stderr keeps a warn tint. */
  :host([terminal]) .message-info,
  :host([terminal]) .message-debug {
    color: inherit;
  }

  :host([terminal]) .message-warn {
    color: var(--wa-color-terminal-ansi-yellow, var(--color-warning));
  }

  :host([terminal]) .message-error {
    color: var(--wa-color-terminal-ansi-red, var(--color-error));
  }

  /* Pre-formatted text nodes for terminal-mode streams.
     Keep committed output and the live tail separate without changing text flow. */
  :host([terminal]) .terminal-container {
    margin: 0;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
    white-space: pre-wrap;
    word-break: break-all;
  }

  :host([terminal]) .terminal-pre {
    display: inline;
    margin: 0;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
    white-space: inherit;
    word-break: inherit;
  }
`;

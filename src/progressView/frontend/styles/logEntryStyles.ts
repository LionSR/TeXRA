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
    padding: var(--spacing-tiny) var(--spacing-medium);
    min-width: 0;
    min-height: 0;
    font-family: var(--font-family);
    font-size: var(--font-size);
    position: relative;
    overflow-y: auto;
  }

  .log-line {
    line-height: 1.4;
    margin: 0;
    padding: calc(var(--spacing-tiny) / 2) 0;
    display: block;
    white-space: pre-wrap;
    word-wrap: break-word;
    word-break: break-all;
  }

  .log-entry-content {
    padding: var(--spacing-small) 0 var(--spacing-medium) var(--spacing-large);
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
    opacity: 0.8;
    font-size: 0.9em;
    margin-left: var(--spacing-tiny);
  }

  .file-list-content .file-source {
    opacity: 0.6;
    font-size: 0.85em;
    font-style: italic;
  }

  .xml-link-container {
    margin-top: var(--spacing-small);
    padding-top: var(--spacing-small);
    border-top: var(--border-thin) solid var(--vscode-widget-border);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-small);
  }

  .xml-link-container .codicon {
    opacity: var(--opacity-subtle);
  }

  .xml-link-container .document-tag {
    color: var(--color-text-secondary);
    opacity: 0.8;
    font-style: italic;
  }

  .xml-link-container .xml-fix-hint {
    flex-basis: 100%;
    margin-top: var(--spacing-tiny);
    color: var(--color-text-secondary);
    font-size: 0.9em;
    display: flex;
    align-items: center;
    gap: var(--spacing-tiny);
  }

  .xml-link-container .xml-fix-hint .codicon {
    opacity: 1;
    color: var(--color-text-link);
  }

  .xml-link-container .xml-fix-hint strong {
    color: var(--color-text-link);
  }

  .detail-item {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  :is(.file-link, .web-search-link) {
    color: var(--color-text-link);
    cursor: pointer;
  }

  :is(.file-link, .web-search-link):hover {
    text-decoration: underline;
  }

  .web-search-link {
    text-decoration: none;
  }

  /* Web search result styles */
  .detail-list {
    list-style: none;
    margin: var(--spacing-small) 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-tiny);
  }

  .file-list-summary {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  /* Toggle icon for collapsible details */
  .toggle-icon {
    transition: transform 0.2s ease;
    display: inline-block;
  }

  details[open] > summary .toggle-icon {
    transform: rotate(90deg);
  }

  /* File list details styling */
  .file-list-details {
    margin: var(--spacing-small) 0;
  }

  .details-summary {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  .banner-content-copy {
    min-width: 0;
    padding: 0 var(--spacing-tiny);
    opacity: 0;
    margin-left: auto;
    transition: opacity 0.2s ease;
    cursor: pointer;
  }

  .details-summary:hover .banner-content-copy,
  .banner-details:focus-within .banner-content-copy,
  .banner-content-copy:focus-visible {
    opacity: 1;
    outline: var(--border-thin) solid var(--vscode-focusBorder);
  }

  .banner-content-copy.copy-success {
    opacity: 1;
    color: var(--color-success);
  }

  .timestamp {
    color: var(--color-text-secondary);
  }

  /* Log level badges */
  :is(.level-debug, .level-info, .level-warn, .level-error) {
    font-weight: bold;
  }

  .level-debug {
    color: var(--vscode-debugTokenExpression-name, #4b9ef9);
  }

  .level-info {
    color: var(--vscode-notificationsInfoIcon-foreground, #75beff);
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
    color: var(--vscode-textPreformat-foreground, #a9b7c6);
  }

  .message-info {
    color: var(--vscode-foreground);
  }

  .banner-summary {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    font-size: var(--font-size);
    font-weight: 600;
  }

  .banner-details {
    margin: var(--spacing-small) 0;
    padding: var(--spacing-small) 0 var(--spacing-small) var(--spacing-large);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-tiny);
  }

  .banner-content {
    margin: 0;
    white-space: pre-wrap;
  }

  .banner-details:not([open]) .banner-content {
    display: none;
  }
`;

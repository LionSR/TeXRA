/**
 * Combined log styles for ProgressView Shadow DOM components.
 */

// Third-party imports
import { css } from 'lit';
import katexStyles from 'katex/dist/katex.min.css?inline';

// Shared styles
import { commonViewStyles } from '@shared/styles';
import { markdownStyles } from '@shared/styles/markdownStyles';

// Import individual style modules
import { logEntryStyles } from './logEntryStyles';
import { groupStyles } from './groupStyles';
import { codeBlockStyles } from './codeBlockStyles';
import { toolUseStyles } from './toolUseStyles';

const katexStyleSheet = new CSSStyleSheet();
katexStyleSheet.replaceSync(katexStyles);

/**
 * Layout styles for Shadow DOM host and child elements.
 * These ensure proper flex layout for the log display hierarchy.
 */
export const layoutStyles = css`
  :host,
  task-group-list {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    contain: layout style paint;
  }

  task-group-list > .log-container {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    contain: layout paint;
  }

  user-message {
    display: block;
  }

  .log-placeholder {
    text-align: center;
    color: var(--color-text-secondary);
    padding: var(--wa-space-s) var(--wa-space-xs);
  }

  /* Class hooks consumed by the shared renderEmptyState() helper
     (@shared/wa/emptyState) when it renders into a .log-placeholder. */
  .log-placeholder .empty-state-icon {
    font-size: calc(var(--font-size) * 1.5);
    opacity: var(--opacity-disabled);
  }

  .log-placeholder .empty-state-title {
    margin: var(--wa-space-2xs) 0 0;
    font-size: var(--wa-font-size-m);
    font-weight: var(--wa-font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .log-placeholder .empty-state-body {
    margin: var(--wa-space-3xs) 0 0;
  }

  .log-placeholder .empty-state-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--wa-space-3xs);
    margin-top: var(--wa-space-xs);
  }
`;

/**
 * Combined log styles - includes layout and all modular styles.
 * Use this for components that need the full set of log styles.
 */
export const logStyles = [
  commonViewStyles,
  katexStyleSheet,
  layoutStyles,
  logEntryStyles,
  groupStyles,
  codeBlockStyles,
  toolUseStyles,
  markdownStyles,
];

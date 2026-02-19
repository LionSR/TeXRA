/**
 * Combined log styles for ProgressView Shadow DOM components.
 */

// Third-party imports
import { css } from 'lit';
import katexStyles from 'katex/dist/katex.min.css?inline';

// Shared styles
import { animationStyles } from '@shared/styles/litStyles';
import { commonViewStyles } from '@shared/styles/commonViewStyles';

// Import and re-export individual style modules
import { logEntryStyles } from './logEntryStyles';
import { groupStyles } from './groupStyles';
import { codeBlockStyles } from './codeBlockStyles';
import { toolUseStyles } from './toolUseStyles';
import { markdownStyles } from './markdownStyles';

const katexStyleSheet = new CSSStyleSheet();
katexStyleSheet.replaceSync(katexStyles);

export {
  logEntryStyles,
  groupStyles,
  codeBlockStyles,
  toolUseStyles,
  markdownStyles,
};

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
  }

  task-group-list > vscode-scrollable,
  vscode-scrollable {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  user-message {
    display: block;
  }

  .log-placeholder {
    text-align: center;
    color: var(--color-text-secondary);
    padding: var(--spacing-large) var(--spacing-medium);
  }

  .log-placeholder a {
    color: var(--color-text-link);
    text-decoration: underline;
  }

  .log-placeholder a:hover {
    text-decoration: none;
  }
`;

/**
 * Combined log styles - includes layout and all modular styles.
 * Use this for components that need the full set of log styles.
 */
export const logStyles = [
  animationStyles,
  commonViewStyles,
  katexStyleSheet,
  layoutStyles,
  logEntryStyles,
  groupStyles,
  codeBlockStyles,
  toolUseStyles,
  markdownStyles,
];

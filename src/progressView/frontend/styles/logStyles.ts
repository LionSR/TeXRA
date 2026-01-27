/**
 * Combined log styles for ProgressView Shadow DOM components.
 */

// Third-party imports
import { css } from 'lit';

// Import and re-export individual style modules
import { logEntryStyles } from './logEntryStyles';
import { groupStyles } from './groupStyles';
import { codeBlockStyles } from './codeBlockStyles';
import { toolUseStyles } from './toolUseStyles';
import { markdownStyles } from './markdownStyles';

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

  log-entry,
  user-message,
  task-group-item {
    display: block;
  }
`;

/**
 * Combined log styles - includes layout and all modular styles.
 * Use this for components that need the full set of log styles.
 */
export const logStyles = [
  layoutStyles,
  logEntryStyles,
  groupStyles,
  codeBlockStyles,
  toolUseStyles,
  markdownStyles,
];

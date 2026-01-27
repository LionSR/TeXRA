/**
 * Combined log styles for ProgressView Shadow DOM components.
 *
 * This module composes all modular style files into a single export
 * for easy consumption by components.
 *
 * Modular styles:
 * - layoutStyles: Host and element layout styles
 * - logEntryStyles: Base log entry, banner, and container styles
 * - groupStyles: Task group header and content styles
 * - codeBlockStyles: Syntax highlighted code block styles
 * - toolUseStyles: Tool-use sections, diffs, and error styles
 * - markdownStyles: Rendered markdown content styles
 */

// Third-party imports
import { css } from 'lit';

// Re-export individual style modules for selective use
export { logEntryStyles } from './logEntryStyles';
export { groupStyles } from './groupStyles';
export { codeBlockStyles } from './codeBlockStyles';
export { toolUseStyles } from './toolUseStyles';
export { markdownStyles } from './markdownStyles';

// Import for composition
import { logEntryStyles } from './logEntryStyles';
import { groupStyles } from './groupStyles';
import { codeBlockStyles } from './codeBlockStyles';
import { toolUseStyles } from './toolUseStyles';
import { markdownStyles } from './markdownStyles';

/**
 * Layout styles for Shadow DOM host and child elements.
 * These ensure proper flex layout for the log display hierarchy.
 */
export const layoutStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

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

  lit-virtualizer {
    display: block;
  }

  log-entry {
    display: block;
  }

  user-message {
    display: block;
  }

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

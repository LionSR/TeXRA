/**
 * Combined log styles for ProgressView Shadow DOM components.
 *
 * This module composes all modular style files into a single export
 * for easy consumption by components.
 *
 * Modular styles:
 * - logEntryStyles: Base log entry, banner, and container styles
 * - groupStyles: Task group header and content styles
 * - codeBlockStyles: Syntax highlighted code block styles
 * - toolUseStyles: Tool-use sections, diffs, and error styles
 * - markdownStyles: Rendered markdown content styles
 */

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
 * Combined log styles - includes all modular styles.
 * Use this for components that need the full set of log styles.
 */
export const logStyles = [
  logEntryStyles,
  groupStyles,
  codeBlockStyles,
  toolUseStyles,
  markdownStyles,
];

/**
 * Shared status indicator styles for Shadow DOM components.
 *
 * Provides consistent styling for:
 * - Status indicator dots (running, stopped, error, waiting, resuming)
 * - Pulse animation for active states
 * - Color-coded status representation
 *
 * Used by: StreamTabs, StreamHeader
 *
 * @example
 * import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';
 *
 * class MyComponent extends LitElement {
 *   static styles = [designTokens, statusIndicatorStyles, css`...`];
 * }
 */

import { css, type CSSResult } from 'lit';

export const statusIndicatorStyles: CSSResult = css`
  /* Base status indicator - small colored dot */
  .status-indicator,
  .tab-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background-color: var(--vscode-descriptionForeground);
    opacity: var(--opacity-subtle, 0.7);
    transition: all 0.3s ease;
  }

  /* Running state - green with glow and pulse */
  .status-indicator.is-running,
  .tab-status.is-running {
    background-color: var(--color-success, #4caf50);
    box-shadow: 0 0 4px var(--color-success, #4caf50);
    opacity: 1;
    animation: pulse-scale 2s infinite;
  }

  /* Stopped state - muted gray */
  .status-indicator.is-stopped,
  .tab-status.is-stopped {
    background-color: var(--vscode-descriptionForeground);
    opacity: var(--opacity-subtle, 0.7);
  }

  /* Error state - red with glow */
  .status-indicator.is-error,
  .tab-status.is-error {
    background-color: var(--color-error, #f44336);
    box-shadow: 0 0 4px var(--color-error, #f44336);
    opacity: 1;
  }

  /* Waiting state - blue with slow pulse */
  .status-indicator.is-waiting,
  .tab-status.is-waiting {
    background-color: var(--vscode-textLink-foreground);
    box-shadow: 0 0 4px var(--vscode-textLink-foreground);
    opacity: 1;
    animation: pulse-scale 3s infinite;
  }

  /* Resuming state - blue with faster pulse */
  .status-indicator.is-resuming,
  .tab-status.is-resuming {
    background-color: var(--vscode-textLink-foreground);
    box-shadow: 0 0 4px var(--vscode-textLink-foreground);
    opacity: 1;
    animation: pulse-scale 1.5s infinite;
  }

  /* Pulse scale animation */
  @keyframes pulse-scale {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.15);
      opacity: 0.8;
    }
  }

  /* Alternative status text styling */
  .status-text {
    font-size: var(--font-size-sm, 12px);
    text-transform: capitalize;
  }

  .status-text.is-running {
    color: var(--color-success, #4caf50);
  }

  .status-text.is-stopped {
    color: var(--color-text-secondary, var(--vscode-descriptionForeground));
  }

  .status-text.is-error {
    color: var(--color-error, #f44336);
  }

  .status-text.is-waiting,
  .status-text.is-resuming {
    color: var(--vscode-textLink-foreground);
  }
`;

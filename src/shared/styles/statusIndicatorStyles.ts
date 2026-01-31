import { css, type CSSResult } from 'lit';

export const statusIndicatorStyles: CSSResult = css`
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

  .status-indicator.is-running,
  .tab-status.is-running {
    background-color: var(--color-success, #4caf50);
    box-shadow: 0 0 4px var(--color-success, #4caf50);
    opacity: 1;
    animation: pulse-scale 2s infinite;
  }

  .status-indicator.is-stopped,
  .tab-status.is-stopped {
    background-color: var(--vscode-descriptionForeground);
    opacity: var(--opacity-subtle, 0.7);
  }

  .status-indicator.is-error,
  .tab-status.is-error {
    background-color: var(--color-error, #f44336);
    box-shadow: 0 0 4px var(--color-error, #f44336);
    opacity: 1;
  }

  .status-indicator.is-waiting,
  .tab-status.is-waiting {
    background-color: var(--vscode-textLink-foreground);
    box-shadow: 0 0 4px var(--vscode-textLink-foreground);
    opacity: 1;
    animation: pulse-scale 3s infinite;
  }

  .status-indicator.is-resuming,
  .tab-status.is-resuming {
    background-color: var(--vscode-textLink-foreground);
    box-shadow: 0 0 4px var(--vscode-textLink-foreground);
    opacity: 1;
    animation: pulse-scale 1.5s infinite;
  }

  .status-indicator.is-ready,
  .tab-status.is-ready {
    background-color: var(--vscode-descriptionForeground);
    opacity: var(--opacity-disabled, 0.5);
  }

  .status-indicator.is-initializing,
  .tab-status.is-initializing {
    background-color: var(--vscode-descriptionForeground);
    box-shadow: 0 0 4px var(--vscode-descriptionForeground);
    opacity: 1;
    animation: pulse-scale 1.8s infinite;
  }

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

  .status-text.is-initializing {
    color: var(--vscode-descriptionForeground);
  }
`;

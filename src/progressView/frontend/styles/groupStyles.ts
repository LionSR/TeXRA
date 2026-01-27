// Third-party imports
import { css } from 'lit';

/**
 * Log group styles for collapsible task groups and run containers.
 */
export const groupStyles = css`
  .log-group-header {
    padding: var(--spacing-tiny) var(--spacing-medium);
    margin: var(--spacing-tiny) 0;
    border-radius: var(--border-radius-small);
    cursor: pointer;
    display: flex;
    align-items: center;
    background-color: transparent;
    border-left: var(--border-medium) solid var(--color-border);
  }

  .log-group-header {
    &.is-running {
      border-left-color: var(--vscode-statusBarItem-warningBackground);
    }

    &.is-error {
      border-left-color: var(--vscode-errorForeground);
    }

    &.is-stopped {
      border-left-color: var(--vscode-testing-iconPassed);
    }
  }

  .log-group-content {
    padding-left: var(--spacing-small);
    border-left: var(--border-thin) dashed
      var(--vscode-editorGroupHeader-tabsBorder);
  }

  .log-run {
    border: none;
  }

  .log-run > .log-group-content {
    padding-left: 0;
    border-left: none;
  }

  .group-status-icon {
    margin-right: var(--spacing-small);
  }

  .group-title {
    font-weight: bold;
    flex-grow: 1;
  }

  .group-time {
    font-size: var(--font-size-sm);
    opacity: var(--opacity-subtle);
    margin-left: var(--spacing-small);
  }

  :is(.group-start-time, .group-duration) {
    margin-right: var(--spacing-small);
  }

  .spin {
    animation: spin 2s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  :is(.log-line, .banner-details)[data-group-id] {
    border-left: var(--border-medium) solid transparent;
  }

  .log-group-content
    > :is(.log-group-header, .log-group-content, .log-line, .banner-details) {
    margin-left: var(--spacing-small);
  }

  .log-group-content .log-group-header {
    border-left-width: var(--border-thin);
  }

  .log-group-content .log-group-content :is(.log-line, .banner-details) {
    margin-left: 0;
  }
`;

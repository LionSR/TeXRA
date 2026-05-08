// Third-party imports
import { css } from 'lit';

/**
 * Log group styles for collapsible task groups and run containers.
 */
export const groupStyles = css`
  .log-group-header {
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    margin: var(--wa-space-3xs) 0;
    border-radius: var(--border-radius-small);
    cursor: pointer;
    display: flex;
    align-items: center;
    background-color: transparent;
    border-left: var(--border-medium) solid var(--color-border);
    transition:
      border-left-color var(--transition-normal),
      background-color var(--transition-fast);
  }

  .log-group-header:hover {
    background-color: var(--texra-list-hoverBackground);
  }

  .log-group-header {
    &.is-running {
      border-left-color: var(--texra-statusBarItem-warningBackground);
    }

    &.is-error {
      border-left-color: var(--texra-errorForeground);
    }

    &.is-stopped {
      border-left-color: var(--texra-testing-iconPassed);
    }
  }

  .log-group-content {
    padding-left: var(--wa-space-2xs);
    border-left: var(--border-thin) dashed
      var(--texra-editorGroupHeader-tabsBorder);
  }

  .log-run {
    border: none;
  }

  .log-run > .log-group-content {
    padding-left: 0;
    border-left: none;
  }

  .group-status-icon {
    margin-right: var(--wa-space-2xs);
  }

  .group-title {
    font-weight: var(--font-weight-bold);
    flex-grow: 1;
  }

  .group-time {
    font-size: var(--font-size-sm);
    opacity: var(--opacity-subtle);
    margin-left: var(--wa-space-2xs);
  }

  :is(.group-start-time, .group-duration) {
    margin-right: var(--wa-space-2xs);
  }

  .log-group {
    content-visibility: auto;
    contain-intrinsic-size: auto 200px;
  }

  /* Note: .spin class and @keyframes spin are in @shared/styles/litStyles.ts */

  :is(.log-line, .banner-details)[data-group-id] {
    border-left: var(--border-medium) solid transparent;
  }

  .log-group-content
    > :is(.log-group-header, .log-group-content, .log-line, .banner-details) {
    margin-left: var(--wa-space-2xs);
  }

  .log-group-content .log-group-header {
    border-left-width: var(--border-thin);
  }

  .log-group-content .log-group-content :is(.log-line, .banner-details) {
    margin-left: 0;
  }
`;

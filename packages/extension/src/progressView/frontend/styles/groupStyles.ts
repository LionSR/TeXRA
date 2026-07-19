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

    &.is-running {
      border-left-color: var(--wa-color-status-warning-bg);
    }

    &.is-failed {
      border-left-color: var(--wa-color-danger-on-quiet);
    }

    &.is-completed,
    &.is-cancelled {
      border-left-color: var(--wa-color-success-fill-loud);
    }
  }

  .log-group-content {
    padding-left: var(--wa-space-2xs);
    border-left: var(--border-thin) dashed var(--wa-color-tabs-border);
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

  /* Group banners are <wa-details> (matching Todos / Background Tasks etc.),
     so the disclosure chevron is consistent with every other panel. Strip the
     WA card chrome so the group reads as an inline disclosure rather than a
     boxed panel — our .log-group-header (status rail + padding) and
     .log-group-content (dashed connector) own the visuals. Unlike the shared
     .collapsible-quiet panels, collapse here is by lazy DOM removal in
     TaskGroupList (not the 1fr/0fr grid trick), so no content-grid rules. */
  wa-details.log-group::part(base) {
    background: transparent;
    border: none;
    border-radius: 0;
  }

  wa-details.log-group::part(header) {
    padding: 0;
    gap: var(--wa-space-2xs);
  }

  wa-details.log-group::part(content) {
    padding: 0;
  }

  /* Note: .spin class and @keyframes spin are in @shared/styles/litStyles.ts */

  :is(.log-line, .banner-details)[data-group-id] {
    border-left: var(--border-medium) solid transparent;
  }

  /* Align custom-element panels with native banner-details indent. */
  .log-group-content
    > :is(
      .log-group-header,
      .log-group-content,
      .log-line,
      .banner-details,
      context-management,
      latexdiff-results
    ) {
    margin-left: var(--wa-space-2xs);
  }

  .log-group-content .log-group-header {
    border-left-width: var(--border-thin);
  }

  .log-group-content
    .log-group-content
    :is(.log-line, .banner-details, context-management, latexdiff-results) {
    margin-left: 0;
  }
`;

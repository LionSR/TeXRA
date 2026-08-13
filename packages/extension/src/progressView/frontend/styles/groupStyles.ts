// Third-party imports
import { css } from 'lit';

/**
 * Log group styles for collapsible task groups and run containers.
 */
export const groupStyles = css`
  .log-group-header {
    padding: var(--wa-space-xs);
    margin: var(--wa-space-2xs) 0;
    border-radius: var(--wa-border-radius-m, var(--border-radius-small));
    cursor: pointer;
    display: flex;
    align-items: center;
    background-color: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 58%,
      transparent
    );
    border-inline-start: 2px solid var(--color-border);

    &.is-running {
      border-inline-start-color: var(--wa-color-status-warning-bg);
    }

    &.is-failed {
      border-inline-start-color: var(--wa-color-danger-on-quiet);
    }

    &.is-completed {
      border-inline-start-color: var(--wa-color-success-fill-loud);
    }

    /* A user stop is neither success nor error, so the rail reads neutral,
       matching the shared status dot and the CLI row marker. */
    &.is-cancelled {
      border-inline-start-color: var(--border-control);
    }
  }

  .log-group-content {
    padding-inline-start: var(--wa-space-xs);
    border-inline-start: var(--border-thin) solid
      color-mix(in srgb, var(--wa-color-tabs-border) 60%, transparent);
  }

  .log-run {
    border: none;
  }

  .log-run > .log-group-content {
    padding-inline-start: 0;
    border-inline-start: none;
  }

  .group-status-icon {
    margin-inline-end: var(--wa-space-2xs);
  }

  .group-title {
    font-weight: var(--font-weight-medium);
    flex-grow: 1;
  }

  /* Completed/declared task count for a phase header, right-aligned beside
     the timestamps. */
  .group-progress {
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-muted);
    margin-inline-start: var(--wa-space-2xs);
  }

  .group-time {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    margin-inline-start: var(--wa-space-2xs);
  }

  :is(.group-start-time, .group-duration) {
    margin-inline-end: var(--wa-space-2xs);
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

  :is(.log-line, .banner-details)[data-group-id] {
    border-inline-start: var(--border-medium) solid transparent;
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
    margin-inline-start: var(--wa-space-2xs);
  }

  .log-group-content .log-group-header {
    border-inline-start-width: var(--border-thin);
  }

  .log-group-content
    .log-group-content
    :is(.log-line, .banner-details, context-management, latexdiff-results) {
    margin-inline-start: 0;
  }
`;

// Third-party imports
import { css } from 'lit';
import { panelFrameStyles } from '@ui/styles/surfaceStyles';

/**
 * Log group styles for collapsible task groups and run containers.
 */
export const groupStyles = css`
  .log-group-header {
    ${panelFrameStyles}
    padding: var(--panel-padding-block) var(--panel-padding-inline);
    margin: var(--wa-space-2xs) 0;
    cursor: pointer;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
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

  /* Group banners are <wa-details> (matching Plan / Background Tasks etc.),
     so the disclosure chevron is consistent with every other panel. Strip the
     WA card chrome so the group reads as an inline disclosure rather than a
     boxed panel — our .log-group-header (frame + padding) and
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

  .log-group-content
    .log-group-content
    :is(.log-line, .banner-details, context-management, latexdiff-results) {
    margin-inline-start: 0;
  }
`;

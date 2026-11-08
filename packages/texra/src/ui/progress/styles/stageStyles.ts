// Third-party imports
import { css } from 'lit';
import { panelFrameStyles } from '@ui/styles/surfaceStyles';

/**
 * Stage styles: a collapsible section, and a script stage's container.
 */
export const stageStyles = css`
  .stage-header {
    ${panelFrameStyles}
    padding: var(--panel-padding-block) var(--panel-padding-inline);
    margin: var(--wa-space-2xs) 0;
    cursor: pointer;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
  }

  .stage-content {
    padding-inline-start: var(--wa-space-xs);
    border-inline-start: var(--border-thin) solid
      color-mix(in srgb, var(--wa-color-tabs-border) 60%, transparent);
  }

  .stage-script {
    border: none;
  }

  .stage-script > .stage-content {
    padding-inline-start: 0;
    border-inline-start: none;
  }

  .stage-status-icon {
    margin-inline-end: var(--wa-space-2xs);
  }

  .stage-title {
    font-weight: var(--font-weight-medium);
    flex-grow: 1;
  }

  .stage-time {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    margin-inline-start: var(--wa-space-2xs);
  }

  :is(.stage-start-time, .stage-duration) {
    margin-inline-end: var(--wa-space-2xs);
  }

  .stage {
    content-visibility: auto;
    contain-intrinsic-size: auto 200px;
  }

  /* Stage banners are <wa-details> (matching Plan / Background Tasks etc.),
     so the disclosure chevron is consistent with every other panel. Strip the
     WA card chrome so the stage reads as an inline disclosure rather than a
     boxed panel — our .stage-header (frame + padding) and
     .stage-content (dashed connector) own the visuals. Unlike the shared
     .collapsible-quiet panels, collapse here is by lazy DOM removal in
     StageList (not the 1fr/0fr grid trick), so no content-grid rules. */
  wa-details.stage::part(base) {
    background: transparent;
    border: none;
    border-radius: 0;
  }

  wa-details.stage::part(header) {
    padding: 0;
    gap: var(--wa-space-2xs);
  }

  wa-details.stage::part(content) {
    padding: 0;
  }

  /* Align custom-element panels with native banner-details indent. */
  .stage-content
    > :is(
      .stage-header,
      .stage-content,
      .log-line,
      .banner-details,
      context-management
    ) {
    margin-inline-start: var(--wa-space-2xs);
  }

  .stage-content
    .stage-content
    :is(.log-line, .banner-details, context-management) {
    margin-inline-start: 0;
  }
`;

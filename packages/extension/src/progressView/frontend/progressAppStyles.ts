// Third-party imports
import { css } from 'lit';

// Shared styles
import { visuallyHiddenStyles } from '@shared/styles';
import { buttonStyles } from '@shared/styles/controlStyles';

/** Layout and empty-state styles for the <progress-app> root component. */
export const progressAppStyles = css`
  :host {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .main-container {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    flex-direction: column;
    overflow: hidden;
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-2xs) 0;
    border-bottom: var(--border-thin) solid var(--color-border);
    flex-shrink: 0;
  }

  /* The full-width view-header border is the single seam under the tab row.
     Suppress the wa-tab-group's own track line and anchor the tabs flush on
     that border (padding-bottom: 0 above) so the two no longer read as a
     doubled rule with a gap between them. The active tab keeps its brand
     indicator bar as the only accent. */
  .view-header wa-tab-group.view-tabs {
    --track-color: transparent;
  }

  .main-container.desktop .view-header {
    display: none;
  }

  .view-header wa-tab.focus-sidebar-tab {
    opacity: var(--opacity-subtle);
    cursor: default;
  }

  ${buttonStyles}

  ${visuallyHiddenStyles}

  .split-container {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .progress-empty-state {
    display: grid;
    flex: 1;
    min-height: 0;
    /* Center the empty-state card on both axes so the route does not
       show a tall stripe of unused space below the panel. The
       align-content: safe center keeps the card visible if the
       viewport is short enough that centering would clip it. */
    place-items: center;
    align-content: safe center;
    padding: var(--wa-space-l, 24px) var(--wa-space-s, 16px);
    overflow: auto;
    font-family: var(--wa-font-family-body, system-ui), sans-serif;
  }

  .progress-empty-panel {
    box-sizing: border-box;
    width: min(720px, 100%);
    padding: var(--wa-space-l, 24px);
    border: var(--border-thin, 1px) solid var(--color-border);
    border-radius: var(--border-radius, 6px);
    background: var(--wa-color-surface-default);
  }

  .progress-empty-panel .empty-state-kicker {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs, 8px);
    margin-bottom: var(--wa-space-xs, 12px);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm, 13px);
    font-weight: var(--font-weight-semibold, 600);
  }

  .progress-empty-panel .empty-state-title {
    margin: 0 0 var(--wa-space-2xs, 8px);
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-h2, 1.25em);
    font-weight: var(--font-weight-semibold, 600);
    line-height: var(--line-height-heading, 1.25);
  }

  .progress-empty-panel .empty-state-body {
    margin: 0;
    color: var(--color-text-secondary);
    line-height: var(--line-height-normal, 1.5);
  }

  .progress-empty-panel .empty-state-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs, 8px);
    margin-top: var(--wa-space-s, 16px);
  }

  .progress-empty-panel .empty-state-actions wa-button::part(base) {
    min-height: var(--height-button);
  }

  wa-icon {
    font-size: 1em;
  }

  wa-split-panel {
    width: 100%;
    height: 100%;
    /* The divider is the one and only seam between the conversation and
       the stream rail. Collapse WebAwesome's default 4px neutral bar to a
       1px hairline that matches every other border in the view; the
       invisible 0.75rem hit-area still makes it easy to drag. */
    --divider-width: var(--border-thin, 1px);
  }

  wa-split-panel::part(divider) {
    background-color: var(--color-border);
  }

  stream-tabs {
    min-width: 180px;
  }

  .main-container.narrow stream-tabs {
    min-width: 48px;
  }

  .main-container.desktop stream-tabs {
    min-width: 240px;
    max-width: 360px;
  }
`;

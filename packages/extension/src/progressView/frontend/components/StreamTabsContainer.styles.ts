// Third-party imports
import { css } from 'lit';

/** Styles for the <stream-tabs> list container. */
export const streamTabsContainerStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    flex: 1;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    min-height: 0;
    overflow: hidden;
  }

  :host([hidden]) {
    display: none;
  }

  /*
   * No own border-left: the single separator between this rail and the
   * conversation is owned by the host layout — the wa-split-panel divider
   * in the extension Progress view, and the desktop-rail border-right in
   * the desktop shell. Drawing one here too produced a doubled seam.
   */
  .tabs {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
    height: 100%;
    overflow: hidden;
    background-color: var(--background-color);
  }

  /*
   * Optional rail header band. Pins to the shared --height-header token so
   * it lines up with the conversation header in the Progress view (and the
   * desktop rail header). Rendered only when a heading is set.
   */
  .stream-tabs-header {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    box-sizing: border-box;
    min-height: var(--height-header);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .stream-tabs-title {
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold, 600);
    letter-spacing: var(--letter-spacing-caps);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .tabs-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    scrollbar-width: thin;
  }

  .tabs-content > div {
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }

  .stream-list-footer {
    flex-shrink: 0;
    border-top: var(--border-thin) solid var(--color-border);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
  }

  .stream-list-controls {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
    min-width: 0;
  }

  .agent-filter-group {
    display: flex;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs);
    flex: 1 1 auto;
    min-width: 0;
  }

  .agent-filter-group wa-radio {
    min-width: auto;
    flex: 0 0 auto;
  }

  .stream-list-actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    margin-left: auto;
  }

  .delete-all-streams {
    color: var(--color-text-secondary);
  }

  .delete-all-streams::part(base) {
    border-radius: var(--border-radius-medium);
  }

  .delete-all-streams:hover {
    color: var(--color-removed);
  }

  /* Recursive child stream nesting */
  .child-streams {
    padding-left: var(--wa-space-xs, 12px);
    border-left: var(--border-thin) solid var(--color-border);
    margin-left: var(--wa-space-2xs);
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .child-streams stream-tab {
    opacity: 1;
    transition: opacity var(--transition-fast);
  }

  .child-streams stream-tab.is-finished {
    opacity: var(--opacity-subtle, 0.5);
  }
`;

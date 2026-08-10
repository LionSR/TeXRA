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

  /* Recursive child stream nesting — indentation alone carries the
     hierarchy (child rows also render a nested-stream chevron). */
  .child-streams {
    padding-inline-start: var(--wa-space-xs, 12px);
    margin-inline-start: var(--wa-space-2xs);
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
`;

/** Shared layout for the three active conversation content surfaces. */

// Third-party imports
import { css, type CSSResult } from 'lit';
import { readingColumnStyles } from '@ui/styles/surfaceStyles';

/**
 * Keeps the transcript as the primary reading surface while preserving the
 * existing component boundaries and event flow. Panels remain outside
 * `<log-list>` so their keyboard shortcuts and lifecycle are unchanged.
 */
export const conversationContentStyles: CSSResult = css`
  :host {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--wa-color-surface-default);
  }

  .conversation-content {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .conversation-column {
    ${readingColumnStyles}
  }

  /* Pending approvals sit above the transcript and are not height-capped
     with the plan. A shared prelude max-height used to clip the Approve
     row when command details filled the pane (sticky actions alone could
     not recover once the whole card sat below the fold). */
  .conversation-approval-dock {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(52%, 30rem);
    padding-block: var(--message-gap) 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-block: contain;
    scrollbar-width: thin;
    position: relative;
    z-index: var(--layer-pinned);
    background: var(--wa-color-surface-default);
  }

  .conversation-prelude,
  .conversation-epilogue {
    flex: 0 1 auto;
    min-height: 0;
    /* The children own their spacing. Empty custom elements still count as
       children, so :empty cannot remove padding from an unused prelude. */
    padding-top: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-block: contain;
    scrollbar-width: thin;
  }

  .conversation-prelude:empty,
  .conversation-epilogue:empty {
    display: none;
  }

  .conversation-prelude {
    max-height: min(38%, 22rem);
  }

  .conversation-epilogue {
    max-height: min(42%, 25rem);
  }

  .conversation-log {
    display: flex;
    flex: 1 1 12rem;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .conversation-log log-list {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .conversation-composer-dock {
    position: relative;
    /* Pinned like the approval dock, and above it. */
    z-index: calc(var(--layer-pinned) + 1);
    flex: 0 0 auto;
    padding: var(--wa-space-xs) 0 var(--wa-space-m);
    background: var(--wa-color-surface-default);
  }

  .conversation-composer-dock session-banners {
    display: block;
    padding: 0 var(--wa-space-3xs);
  }

  .conversation-ended {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--wa-space-s);
    min-height: var(--height-button);
    padding: var(--wa-space-s) 0 0;
    border-top: var(--border-thin) solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  /* A fork's first line, where its own transcript begins. */
  .forked-from-line {
    display: flex;
    align-items: baseline;
    gap: var(--wa-space-2xs);
    margin: var(--wa-space-xs) 0;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .conversation-ended > span {
    flex: 1 1 auto;
  }

  @container (max-width: 640px) {
    .conversation-approval-dock {
      max-height: min(48%, 24rem);
    }

    .conversation-prelude {
      max-height: min(34%, 17rem);
    }

    .conversation-epilogue {
      max-height: min(36%, 18rem);
    }

    .conversation-composer-dock {
      padding-bottom: var(--wa-space-xs);
    }
  }
`;

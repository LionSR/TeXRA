/** Shared layout for the three active conversation content surfaces. */

// Third-party imports
import { css, type CSSResult } from 'lit';

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
    width: min(
      var(--conversation-reading-width, 800px),
      calc(100% - 2 * var(--wa-space-m))
    );
    min-width: 0;
    margin-inline: auto;
    box-sizing: border-box;
  }

  /* Pending approvals sit above the transcript and are not height-capped
     with todos/plans. A shared prelude max-height used to clip the Approve
     row when command details filled the pane (sticky actions alone could
     not recover once the whole card sat below the fold). */
  .conversation-approval-dock {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(52%, 30rem);
    padding-top: var(--wa-space-xs);
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: thin;
    position: relative;
    z-index: 2;
    background: var(--wa-color-surface-default);
  }

  .conversation-prelude,
  .conversation-epilogue {
    flex: 0 1 auto;
    min-height: 0;
    padding-top: var(--wa-space-xs);
    overflow-x: hidden;
    overflow-y: auto;
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
    z-index: 3;
    flex: 0 0 auto;
    padding: var(--wa-space-xs) 0 var(--wa-space-s);
    background: linear-gradient(
      to bottom,
      transparent,
      var(--wa-color-surface-default) var(--wa-space-m)
    );
  }

  .conversation-composer-dock follow-up-input {
    display: block;
  }

  @container (max-width: 640px) {
    .conversation-column {
      width: calc(100% - 2 * var(--wa-space-xs));
    }

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

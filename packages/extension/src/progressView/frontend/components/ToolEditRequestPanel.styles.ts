/** Component-scoped styles for {@link ToolEditRequestPanel} (tool edit approval requests). */

import { css, type CSSResult } from 'lit';

import { sp } from '@shared/styles';

export const toolEditRequestPanelStyles: CSSResult = css`
  .approval-request__path {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    color: var(--color-text-link);
    word-break: break-word;
  }

  .approval-request__diff {
    display: inline-flex;
    align-items: baseline;
    gap: ${sp.small};
  }

  .approval-request__diff-added,
  .approval-request__diff-removed {
    font-size: var(--font-size-xs);
  }

  .approval-request__diff-added {
    color: var(--color-added);
  }

  .approval-request__diff-removed {
    color: var(--color-removed);
  }

  .approval-request__diff-label {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
    opacity: var(--opacity-normal);
  }

  .approval-request__actions .diff-dropdown {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    flex: 1 1 7rem;
    min-width: 0;
    max-width: min(8.25rem, 100%);
  }

  .approval-request__actions .diff-dropdown .diff-main-button {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
  }

  /* Square the inner corners so the label and caret fuse into one pill. */
  .approval-request__actions .diff-dropdown .diff-main-button::part(base) {
    width: 100%;
    min-width: 0;
    justify-content: center;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  /* wa-dropdown handles its own popup positioning; pull the caret onto the
     label so their 1px borders overlap into a single divider on hover. */
  .approval-request__actions .diff-dropdown .diff-dropdown-menu {
    flex: 0 0 auto;
    display: inline-flex;
    margin-left: calc(-1 * var(--border-thin));
  }

  .approval-request__actions .diff-dropdown .diff-dropdown-trigger {
    flex: 0 0 auto;
    width: 1.5rem;
    min-width: 1.5rem;
  }

  /* Match the .action-button chrome: borderless at rest with the border
     reserved (transparent) so nothing shifts, caret at full presence, and only
     the right corners rounded so it tucks against the label. */
  .approval-request__actions .diff-dropdown .diff-dropdown-trigger::part(base) {
    min-height: var(--height-control-compact);
    height: auto;
    width: 100%;
    padding: 0;
    opacity: var(--opacity-full);
    background: transparent;
    border: var(--border-thin) solid transparent;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .approval-request__actions
    .diff-dropdown
    .diff-dropdown-trigger::part(base):hover {
    background: transparent;
  }

  .approval-request__actions .diff-dropdown .diff-dropdown-trigger wa-icon {
    font-size: var(--font-size-sm);
  }

  /* Hovering or opening either half outlines the whole pair as one box with a
     single internal divider, so the caret reads as the diff button's menu
     rather than a stray glyph floating beside it. */
  .approval-request__actions .diff-dropdown:hover .diff-main-button::part(base),
  .approval-request__actions
    .diff-dropdown:hover
    .diff-dropdown-trigger::part(base),
  .approval-request__actions
    .diff-dropdown:focus-within
    .diff-main-button::part(base),
  .approval-request__actions
    .diff-dropdown:focus-within
    .diff-dropdown-trigger::part(base),
  .approval-request__actions
    .diff-dropdown
    wa-dropdown[open]
    .diff-main-button::part(base),
  .approval-request__actions
    .diff-dropdown
    wa-dropdown[open]
    .diff-dropdown-trigger::part(base) {
    border-color: var(--wa-color-surface-border, var(--color-border));
  }

  .approval-request__actions
    .diff-dropdown
    .diff-dropdown-trigger:focus-visible::part(base) {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: var(--border-thin);
  }

  .approval-request__actions
    .diff-dropdown
    wa-dropdown[open]
    .diff-dropdown-trigger
    wa-icon {
    transform: rotate(180deg);
  }
`;

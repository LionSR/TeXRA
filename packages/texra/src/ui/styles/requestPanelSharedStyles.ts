/**
 * Shared CSS for the one request card every pending request renders as
 * (`BaseRequestPanel.renderCard`): `.request-card` with its `__ask`,
 * `__details`, `__actions` and `__note` parts. A panel sets its accent with
 * `:host { --request-accent: … }` and adds only its own body rules.
 */

import { css, unsafeCSS, type CSSResult } from 'lit';

export const sp = {
  tiny: unsafeCSS('var(--wa-space-3xs)'),
  small: unsafeCSS('var(--wa-space-2xs)'),
  medium: unsafeCSS('var(--wa-space-xs)'),
  large: unsafeCSS('var(--wa-space-s)'),
} as const;

export const requestPanelSharedStyles: CSSResult = css`
  :host {
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
  }

  .request-card {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
    position: relative;
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    padding: ${sp.medium};
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-inline-start: var(--border-medium) solid
      var(--request-accent, var(--wa-color-text-normal));
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-raised);
  }

  /* The ask is the card's heading: one sentence naming what the agent
     wants. The h3 reset keeps it at body size. */
  .request-card__ask {
    margin: 0;
    font: inherit;
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-normal);
    overflow-wrap: anywhere;
  }

  .request-card__ask code {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    font-variant-ligatures: none;
  }

  /* Cap the evidence so the action row stays on screen in the height-capped
     dock; long commands and questions scroll here. */
  .request-card__details {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    flex: 1 1 auto;
    min-height: 0;
    max-height: min(28vh, 16rem);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  @media (max-height: 900px) {
    .request-card__details {
      max-height: min(22vh, 12rem);
    }
  }

  .request-card__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${sp.small};
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  /* The quoted context an agent attaches to a question. */
  .request-card__context {
    padding: ${sp.small} ${sp.medium};
    border-radius: var(--border-radius-small);
    background: var(--wa-color-surface-lowered);
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .request-card__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${sp.small};
    min-width: 0;
    max-width: 100%;
    /* Pinned under the details so the buttons stay visible while long
       content scrolls. */
    flex: 0 0 auto;
    position: sticky;
    inset-block-end: 0;
    z-index: 1;
    margin-block-start: auto;
    padding-block-start: ${sp.small};
    background: var(--wa-color-surface-raised);
  }

  .request-card__actions > * {
    min-width: 0;
    max-width: 100%;
  }

  /* Buttons hug their label and wrap to the next row rather than clip. */
  .request-card__actions .action-button,
  .request-card__actions .split-group {
    flex: 0 1 auto;
    min-width: auto;
    max-width: min(16rem, 100%);
  }

  .request-card__actions wa-button[data-action='note']::part(base) {
    color: var(--wa-color-text-quiet);
  }

  /* Prose note, same sizing contract as the progress composer: rest at two
     lines, grow with content, keep a vertical drag handle. */
  .request-card__note {
    display: block;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    --textarea-min-height: calc(2lh + var(--wa-space-xs) + var(--wa-space-3xs));
    --textarea-max-height: clamp(var(--textarea-min-height), 24vh, 10rem);
  }

  .request-card__note::part(textarea-wrapper),
  .request-card__note::part(base) {
    align-items: start;
    min-height: var(--textarea-min-height);
  }

  .request-card__note::part(textarea) {
    field-sizing: content;
    width: 100%;
    height: auto;
    min-height: var(--textarea-min-height);
    max-height: var(--textarea-max-height);
    padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-3xs);
    box-sizing: border-box;
    overflow-x: hidden;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size);
    line-height: var(--line-height-relaxed);
  }
`;

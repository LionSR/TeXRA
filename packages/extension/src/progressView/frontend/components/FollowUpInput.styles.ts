/** Component-scoped styles for {@link FollowUpInput} (composer + actions). */

import { css, type CSSResult } from 'lit';

import { proseTextareaPartRule } from '@shared/styles/requestPanelSharedStyles';

export const followUpInputStyles: CSSResult = css`
  :host {
    display: none;
  }

  :host([visible]) {
    display: block;
    max-width: 100%;
  }

  /* VS Code only (see useCollapsibleShell): match Todos / Plan chrome. */
  wa-details.panel-collapsible {
    min-width: 0;
  }

  .follow-up-container {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
    min-width: 0;
  }

  .follow-up-container > queued-follow-ups {
    display: block;
    min-width: 0;
  }

  .composer-surface {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: var(--wa-space-3xs);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-xl, 20px);
    background: var(--wa-color-surface-raised);
    box-shadow:
      0 1px 2px
        color-mix(in srgb, var(--wa-color-surface-shadow) 18%, transparent),
      0 8px 28px
        color-mix(in srgb, var(--wa-color-surface-shadow) 12%, transparent);
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast);
  }

  .composer-surface:focus-within {
    /* One ring around the whole card; the plain native textarea inside draws
       no focus chrome of its own. */
    outline: var(--focus-ring-width) solid var(--wa-color-focus);
    outline-offset: var(--focus-ring-offset);
    box-shadow:
      0 1px 2px
        color-mix(in srgb, var(--wa-color-surface-shadow) 20%, transparent),
      0 10px 32px
        color-mix(in srgb, var(--wa-color-surface-shadow) 16%, transparent);
  }

  /* The composer rests at two lines and grows with what you type, up to
     the max below, so a substantial instruction still gets room without
     an empty draft reserving it. field-sizing does the growing; the drag
     affordance stays for anyone who wants a taller box than their text.
     A plain native textarea, not wa-textarea: the composer strips every
     piece of WA form-control chrome (label, hint, border, focus ring), so
     carrying the component only meant overriding all of it away. */
  #followUpInput {
    --textarea-min-height: calc(2lh + var(--wa-space-xs) + var(--wa-space-3xs));
    --textarea-max-height: clamp(var(--textarea-min-height), 32vh, 240px);
    display: block;
    min-width: 0;
    margin: 0;
    border: 0;
    outline: none;
    background: transparent;
    resize: vertical;
    ${proseTextareaPartRule}
  }

  .follow-up-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--wa-space-3xs);
    min-height: 36px;
    padding: 0 var(--wa-space-3xs) var(--wa-space-3xs);
  }

  /* Composer buttons take the large step off the shared control scale; the
     circular radius is the one local departure, so the send affordance
     reads as a button on a composer rather than a toolbar icon. Fill,
     color, and hover all come from the shared icon-button skin. */
  .follow-up-actions .action-icon-button,
  .follow-up-actions .action-icon-busy {
    --control-size: var(--control-size-l);
  }

  .follow-up-actions .action-icon-busy {
    width: var(--control-size);
    min-width: var(--control-size);
    height: var(--control-size);
  }

  .follow-up-actions .action-icon-button::part(base) {
    border-radius: var(--wa-border-radius-circle);
  }

  .follow-up-actions > .action-icon-busy:has(.composer-primary-action) {
    margin-inline-start: auto;
  }

  .follow-up-actions .recording::part(base) {
    color: var(--wa-color-danger-on-quiet);
    background: var(--wa-color-danger-fill-quiet);
  }

  @container (max-width: 440px) {
    #followUpInput {
      padding-inline: var(--wa-space-xs);
    }
  }
`;

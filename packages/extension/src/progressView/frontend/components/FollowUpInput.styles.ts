/** Component-scoped styles for {@link FollowUpInput} (composer + actions). */

import { css, type CSSResult } from 'lit';

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
    border-color: color-mix(
      in srgb,
      var(--wa-color-focus) 42%,
      var(--wa-color-surface-border)
    );
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
     Not Web Awesome's resize="auto": that copies the scroll height into an
     invisible grid item which, inside a constrained composer, keeps an
     oversized row for an empty draft. */
  #followUpInput {
    display: block;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    line-height: var(--line-height-relaxed);
    height: auto;
    --textarea-min-height: calc(2lh + var(--wa-space-xs) + var(--wa-space-3xs));
    --textarea-max-height: clamp(var(--textarea-min-height), 32vh, 240px);
  }

  #followUpInput::part(textarea-wrapper) {
    align-items: start;
    max-height: var(--textarea-max-height);
    overflow: hidden;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  /* The one place a textarea renders sans rather than mono: this is prose a
     user writes to an agent, not code. */
  #followUpInput::part(textarea) {
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

  .follow-up-actions .recording::part(base) {
    color: var(--wa-color-danger-on-quiet);
    background: var(--wa-color-danger-fill-quiet);
  }

  @container (max-width: 440px) {
    #followUpInput::part(textarea) {
      padding-inline: var(--wa-space-xs);
    }
  }
`;

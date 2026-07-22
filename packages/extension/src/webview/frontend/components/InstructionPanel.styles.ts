/** Component-scoped styles for {@link InstructionPanel}. */

import { css, type CSSResult } from 'lit';

export const instructionPanelStyles: CSSResult = css`
  :host {
    display: block;
    /* Both agent + model selects share this width so the two boxes are
       identical at every viewport. clamp() floors at the min so the
       formula can't go negative on viewports < 12rem. */
    --agent-select-max-width: clamp(7rem, calc((100vw - 12rem) / 2), 12rem);
    --agent-model-listbox-min-width: 12rem;
    --agent-model-listbox-max-width: min(
      20rem,
      calc(100vw - var(--wa-space-l))
    );
  }

  .instruction-box {
    display: flex;
    flex-direction: column;
    position: relative;
    padding: var(--wa-space-3xs) var(--wa-space-xs);
    background-color: var(--background-color);
    border-radius: var(--border-radius);
    margin-bottom: var(--wa-space-3xs);
    border: var(--border-thin) solid var(--color-border);
  }

  .instruction-box:focus-within {
    border-color: color-mix(
      in srgb,
      var(--wa-color-brand-fill-loud) 35%,
      var(--color-border)
    );
  }

  .instruction-box.drop-active {
    border-color: var(--wa-color-brand-fill-loud);
  }

  .instruction-box.drop-active::after {
    content: 'Drop to attach';
    position: absolute;
    inset: var(--wa-space-3xs);
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--wa-color-brand-fill-loud);
    border-radius: var(--border-radius);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-default) 78%,
      transparent
    );
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    pointer-events: none;
  }

  .instruction-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--wa-space-2xs);
    margin-bottom: var(--wa-space-3xs);
    line-height: var(--line-height-normal);
    flex-wrap: wrap;
    min-height: var(--height-control-compact);
  }

  .instruction-header-leading {
    display: flex;
    gap: var(--wa-space-2xs);
    align-items: center;
    flex-wrap: wrap;
  }

  .instruction-header-actions {
    display: flex;
    gap: var(--wa-space-3xs);
    align-items: center;
  }

  .instruction-session-toggle {
    display: flex;
    align-items: center;
  }

  .instruction-session-toggle wa-radio-group {
    display: flex;
    gap: var(--wa-space-2xs);
  }

  .instruction-session-toggle wa-radio {
    font-size: var(--font-size-sm);
  }

  /* Native wa-callout (brand), compacted to IDE density. The callout
     supplies the tinted background + border + radius; we only tighten the
     padding/typography and lay its content out in a single row. */
  .session-hint {
    margin-top: var(--wa-space-2xs);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
    animation: session-hint-fade 150ms ease;
  }

  .session-hint::part(message) {
    display: flex;
    gap: var(--wa-space-2xs);
    align-items: flex-start;
    color: var(--wa-color-text-quiet);
  }

  @keyframes session-hint-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .session-hint-lede {
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .session-hint-body {
    flex: 1 1 auto;
  }

  .session-hint-time {
    color: var(--wa-color-text-quiet);
    opacity: var(--opacity-normal);
  }

  .session-hint-dismiss {
    flex: 0 0 auto;
    margin-left: var(--wa-space-3xs);
  }

  wa-textarea#instruction {
    width: 100%;
    margin: var(--wa-space-3xs) 0;
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size);
  }

  wa-textarea#instruction::part(textarea) {
    max-height: var(--height-xlarge);
  }

  .instruction-controls {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs) var(--wa-space-s);
    flex-wrap: wrap;
    width: 100%;
    min-height: var(--height-control);
  }

  /* Promote the footer's groups into the controls flex row so every group,
     including Execute, wraps in DOM order. This keeps the primary action at
     the right edge of whichever row is final instead of vertically centering
     it beside a separately wrapped picker container. */
  .model-selection-footer {
    display: contents;
  }

  .model-selection-footer .select-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex: 0 0 auto;
    min-width: 0;
  }

  .model-selection-footer .launch-target-group {
    flex: 0 0 auto;
  }

  .launch-target-group wa-radio-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .launch-target-group wa-radio {
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .model-selection-footer .agent-select-group,
  .model-selection-footer .model-select-group {
    flex-basis: calc(
      var(--agent-select-max-width) + var(--height-control) +
        var(--wa-space-2xs)
    );
    max-width: calc(
      var(--agent-select-max-width) + var(--height-control) +
        var(--wa-space-2xs)
    );
  }

  .model-selection-footer .agent-model-select-group {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  .launcher-picker-fade {
    animation: session-hint-fade 150ms ease;
  }

  .model-selection-footer wa-icon,
  .model-selection-footer wa-button {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    line-height: 1;
  }

  .model-selection-footer wa-button {
    min-width: var(--height-control);
    height: var(--height-control);
  }

  /*
   * Execute is the primary action of the entire UI, so it gets a
   * slightly larger, more distinctive treatment than the other
   * footer wa-buttons (which are 24x24 icon-only controls).
   */
  wa-button.execute-button {
    min-width: auto;
    height: auto;
    flex: 0 0 auto;
    margin-left: auto;
  }

  wa-button.execute-button::part(base) {
    min-width: 64px;
    min-height: 24px;
    height: 24px;
    padding: 0 var(--wa-space-s);
    gap: var(--wa-space-2xs);
    border-radius: var(--wa-border-radius-m);
    background: var(--wa-color-brand-fill-loud);
    color: var(--wa-color-brand-on-loud);
    border: var(--border-thin) solid
      color-mix(in srgb, black 8%, var(--wa-color-brand-fill-loud));
    font-weight: var(--font-weight-semibold, 600);
    letter-spacing: 0.01em;
  }

  wa-button.execute-button:focus-visible::part(base) {
    outline: 2px solid var(--wa-color-focus, var(--wa-color-brand-fill-loud));
    outline-offset: 2px;
  }

  wa-button.execute-button wa-icon {
    font-size: var(--font-size-sm);
  }

  .execute-button__label {
    font-size: var(--font-size-sm);
    line-height: 1;
  }

  /* Lock both selects to identical fixed width. Without flex: 0 0, the
     agent box would shrink/stretch with its label content (e.g.
     "humanize" vs. "🎯 orchestrator ☁"), shifting the model select to
     a different x position between modes. */
  .model-selection-footer .agent-select-group wa-select,
  .model-selection-footer .model-select-group wa-select {
    flex: 0 0 var(--agent-select-max-width);
    width: var(--agent-select-max-width);
    min-width: var(--agent-select-max-width);
    max-width: var(--agent-select-max-width);
    font-size: var(--font-size-sm);
  }

  .model-selection-footer .model-select::part(listbox),
  .model-selection-footer .agent-select::part(listbox) {
    min-width: var(--agent-model-listbox-min-width);
    max-width: var(--agent-model-listbox-max-width);
  }

  /* Footer dropdowns open upward */
  wa-select::part(listbox) {
    bottom: 100%;
    top: auto;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 420px) {
    .model-selection-footer .launch-target-group {
      flex-basis: 100%;
    }

    .launch-target-group wa-radio-group,
    .launch-target-group wa-radio {
      min-width: max-content;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .session-hint,
    .launcher-picker-fade {
      animation: none;
    }
  }

  .recording {
    color: var(--wa-color-danger-on-quiet);
    animation: pulse-record 1.2s ease-in-out infinite;
    transform-origin: center;
  }

  @keyframes pulse-record {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: var(--opacity-disabled);
      transform: scale(1.05);
    }
  }
`;

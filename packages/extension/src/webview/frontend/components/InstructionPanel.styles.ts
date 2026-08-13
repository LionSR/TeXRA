/** Component-scoped styles for {@link InstructionPanel}. */

import { css, type CSSResult } from 'lit';

export const instructionPanelStyles: CSSResult = css`
  :host {
    display: block;
    /* Both agent + model selects share this width so the two boxes are
       identical at every viewport. clamp() floors at the min so the
       formula can't go negative on viewports < 12rem. */
    --agent-select-max-width: clamp(6rem, calc((100vw - 12rem) / 3), 9rem);
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
    gap: var(--wa-space-2xs);
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
    animation: session-hint-fade var(--transition-fast);
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

  /* No element opacity: --wa-color-text-quiet is already 70% alpha, and the
     extra 0.85 composited to 3.18:1 on the brand callout. */
  .session-hint-time {
    color: var(--wa-color-text-quiet);
  }

  .session-hint-dismiss {
    flex: 0 0 auto;
    margin-inline-start: var(--wa-space-3xs);
  }

  /* Sizing, font, and padding come from formControlStyles' wa-textarea rules;
     only the growth cap is local (this is the composer, so it grows further
     than a settings field). */
  wa-textarea#instruction {
    width: 100%;
    margin: var(--wa-space-3xs) 0;
    --textarea-min-height: var(--textarea-h-s);
    --textarea-max-height: var(--height-xlarge);
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

  .model-selection-footer .workspace-root-control {
    flex: 1 1 12rem;
    max-width: 20rem;
  }

  .workspace-root-select {
    width: 100%;
    min-width: 0;
    font-size: var(--font-size-sm);
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
    position: relative;
  }

  .launcher-picker-pane {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    transition: opacity var(--transition-fast);
  }

  .team-picker-pane {
    opacity: 0;
    pointer-events: none;
  }

  .agent-picker-pane {
    opacity: 0;
    pointer-events: none;
    position: absolute;
    inset: 0;
  }

  .team-picker-visible .team-picker-pane {
    opacity: 1;
    pointer-events: auto;
    position: static;
  }

  .team-picker-visible .agent-picker-pane {
    opacity: 0;
    pointer-events: none;
    position: absolute;
  }

  .agent-picker-visible .agent-picker-pane {
    opacity: 1;
    pointer-events: auto;
    position: static;
  }

  .agent-picker-visible .team-picker-pane {
    opacity: 0;
    pointer-events: none;
    position: absolute;
  }

  .model-selection-footer wa-icon,
  .model-selection-footer wa-button {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    line-height: var(--line-height-tight);
  }

  .model-selection-footer wa-button:not(.action-icon-button) {
    min-width: var(--height-control);
    height: var(--height-control);
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

  /* Electron opts into a conversation-first composer while the extension
     retains the compact form above. The outer card owns the visual boundary;
     the textarea becomes a quiet, borderless writing surface inside it. */
  :host([desktop-host]) {
    width: 100%;
    container-name: desktop-composer;
    container-type: inline-size;
    --agent-model-listbox-max-width: min(24rem, calc(100vw - 3rem));
  }

  :host([desktop-host]) .instruction-box {
    gap: var(--wa-space-2xs);
    margin: 0;
    padding: var(--wa-space-xs);
    border-color: var(--border-hairline-strong);
    border-radius: var(--border-radius-large);
    background: var(--wa-color-surface-raised);
    transition: border-color var(--transition-fast);
  }

  :host([desktop-host]) .instruction-box:focus-within {
    border-color: color-mix(
      in srgb,
      var(--wa-color-focus) 55%,
      var(--border-hairline-strong)
    );
    box-shadow: 0 0 0 2px var(--wa-color-brand-fill-quiet);
  }

  :host([desktop-host]) .instruction-box.drop-active::after {
    inset: var(--wa-space-2xs);
    border-radius: var(--border-radius-large);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-raised) 92%,
      transparent
    );
  }

  :host([desktop-host]) .session-hint {
    /* Desktop gives the same guidance through the mode tooltips and the
       launcher welcome copy; keeping the full IDE callout inside a compact
       composer would push the prompt away from the bottom edge. */
    display: none;
  }

  :host([desktop-host]) wa-textarea#instruction {
    order: 1;
    margin: 0;
    color: var(--wa-color-text-normal);
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size-prose, var(--font-size-lg));
    line-height: var(--line-height-relaxed);
    --wa-form-control-background-color: transparent;
    --wa-form-control-border-color: transparent;
    --wa-form-control-border-width: 0;
    --wa-form-control-padding-block: 0.55rem;
    --wa-form-control-padding-inline: 0.45rem;
  }

  :host([desktop-host]) wa-textarea#instruction::part(base) {
    border: 0;
    background: transparent;
    outline: 0;
  }

  :host([desktop-host]) wa-textarea#instruction::part(textarea) {
    min-height: 96px;
    max-height: min(36vh, 240px);
  }

  :host([desktop-host]) .instruction-header {
    order: 2;
    justify-content: flex-start;
    min-height: var(--control-size-m);
    margin: 0;
    padding: 0;
    flex-wrap: nowrap;
  }

  :host([desktop-host]) .instruction-header-leading {
    flex: 0 0 auto;
    min-width: 0;
    flex-wrap: nowrap;
  }

  :host([desktop-host]) .desktop-drop-affordance {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    min-width: 0;
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
  }

  :host([desktop-host])
    :is(.instruction-header-actions, .model-selection-footer)
    .action-icon-button {
    --control-size: var(--control-size-m);
  }

  :host([desktop-host]) .desktop-drop-affordance .icon-surface wa-icon {
    display: block;
    flex: 0 0 auto;
    width: 1em;
    height: 1em;
    font-size: var(--font-size-icon-sm);
    line-height: var(--line-height-tight);
  }

  :host([desktop-host]) .instruction-header-actions {
    flex: 0 0 auto;
    gap: var(--wa-space-3xs);
  }

  :host([desktop-host]) .instruction-controls {
    order: 3;
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    align-items: end;
    gap: var(--wa-space-2xs);
    min-height: var(--control-size-l);
  }

  :host([desktop-host]) .model-selection-footer {
    display: grid;
    grid-template-columns:
      minmax(7rem, 0.6fr) minmax(7.5rem, 1fr)
      minmax(7.5rem, 1fr);
    align-items: center;
    gap: var(--wa-space-2xs);
    min-width: 0;
  }

  :host([desktop-host]) .desktop-mode-controls {
    min-width: 0;
  }

  :host([desktop-host]) .workspace-root-control {
    grid-column: 1 / -1;
    max-width: none;
  }

  :host([desktop-host]) .desktop-launch-mode {
    width: 100%;
  }

  :host([desktop-host]) .model-selection-footer .select-group {
    gap: var(--wa-space-3xs);
  }

  :host([desktop-host]) .model-selection-footer .agent-select-group,
  :host([desktop-host]) .model-selection-footer .model-select-group {
    max-width: none;
  }

  :host([desktop-host])
    .model-selection-footer
    :is(.agent-select-group, .model-select-group)
    wa-select {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    max-width: none;
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

  /* The conversation can be narrower than the window when a workbench is
     open, so responsive composition follows this component's own width. */
  @container desktop-composer (max-width: 640px) {
    :host([desktop-host]) .model-selection-footer {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    :host([desktop-host]) .model-select-group {
      grid-column: 1 / -1;
    }
  }

  @container desktop-composer (max-width: 460px) {
    :host([desktop-host]) .model-selection-footer {
      grid-template-columns: minmax(0, 1fr);
    }

    :host([desktop-host])
      .model-selection-footer
      :is(.agent-select-group, .model-select-group) {
      gap: var(--wa-space-3xs);
    }

    :host([desktop-host]) .model-select-group {
      grid-column: auto;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .session-hint,
    .launcher-picker-pane,
    :host([desktop-host]) .instruction-box {
      transition: none;
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

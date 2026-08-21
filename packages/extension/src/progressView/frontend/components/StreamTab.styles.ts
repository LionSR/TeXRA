// Third-party imports
import { css } from 'lit';

/** Styles for the individual <stream-tab> row. */
export const streamTabStyles = css`
  :host {
    display: block;
    container-type: inline-size;
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .tab-container {
    display: flex;
    align-items: center;
    position: relative;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    gap: var(--wa-space-3xs);
    border-inline-start: var(--border-medium) solid
      var(--stream-status-rail-color, var(--stream-status-color, transparent));
    box-sizing: border-box;
    overflow: hidden;
  }

  .tab-container.status-running {
    --stream-status-color: var(--color-success);
  }

  .tab-container.status-error,
  .tab-container.status-failed {
    --stream-status-color: var(--color-error);
  }

  .tab-container.status-waiting,
  .tab-container.status-resuming {
    --stream-status-color: var(--wa-color-text-link);
  }

  .tab-container.status-initializing,
  .tab-container.status-starting {
    --stream-status-color: var(--color-warning);
  }

  /* Finished states (stopped/completed/cancelled/ready) keep the
     transparent default: the rail only lights up while something is
     happening or needs attention. */

  /* Pending approval — solid orange start rail. */
  .tab-container.has-pending-approval {
    --stream-status-color: var(--color-warning);
    --stream-status-rail-color: var(--color-chart-orange);
  }

  .tab-select-tooltip-anchor {
    flex: 1;
    display: flex;
    min-width: 0;
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    cursor: pointer;
    border: none;
    background: none;
    color: var(--wa-color-text-normal);
    text-align: left;
    font-family: var(--font-family);
    min-width: 0;
    overflow-x: hidden;
  }

  .tab-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    width: 100%;
    min-width: 0;
  }

  .tab-title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Canonical states use only the glyph; defensive unknown states retain text.
     Selection overrides both below so row hierarchy remains stronger than
     lifecycle. */
  .tab-status {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: var(--wa-space-3xs);
    max-width: 50%;
    overflow: hidden;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-xs);
    line-height: var(--line-height-tight);
    white-space: nowrap;
  }

  .tab-status-icon {
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 1em;
    min-inline-size: 1em;
    block-size: 1em;
    color: var(--stream-status-color, var(--color-text-muted));
  }

  .tab-status-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-meta {
    display: none;
    align-items: center;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    width: 100%;
    min-width: 0;
    overflow: hidden;
  }

  /* Reveal the metadata line on hover, focus, or selection. The agent name
     renders as inline text on this line, alongside the worktree chip,
     timestamp, and model, when the title is the AI session one-liner. */
  .tab-container:hover .tab-meta,
  .tab-container:focus-within .tab-meta,
  .tab-container.is-active .tab-meta {
    display: flex;
  }

  .tab-meta .remote-agent,
  .tab-meta .stream-kind {
    margin-inline-start: var(--wa-space-2xs);
  }

  /* 24px literal, not --control-size-s: that step is bridged to 20px in the
     extension (common.css) for editor-chrome density, which is under WCAG
     2.5.8's floor. The row's own select target sits flush against this one, so
     the spacing exception does not apply and it has to meet 24x24 outright —
     and growing the hit area with a pseudo-element instead would overlap the
     select target, making near-misses delete a session. 24px is also exactly
     --wa-row-height, so the row does not get taller. */
  .tab-delete {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    min-width: 24px;
    height: 24px;
    margin-block: 0;
    margin-inline: var(--wa-space-2xs) 0;
    color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
    opacity: 0;
    position: relative;
    z-index: 10;
  }

  /* Reveal the delete affordance only when the row is hovered,
   * focused, or selected — keeps the tabs clean at rest. */
  .tab-container:hover .tab-delete,
  .tab-container.is-active .tab-delete,
  .tab-delete:focus-visible,
  .tab-delete:focus-within {
    opacity: 1;
  }

  .tab-container:hover {
    background-color: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 30%,
      transparent
    );
  }

  /*
   * The descendant wildcard rule below forces nested spans
   * (.last-active, .model) and codicon glyphs to inherit the selection
   * color even when intermediate elements define their own.
   */
  .tab-container.is-active {
    background-color: color-mix(
      in srgb,
      var(--wa-color-brand-fill-quiet) 85%,
      transparent
    );
    color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
  }

  /*
   * Single descendant rule covers .tab, .tab-title, .tab-meta,
   * .tab-delete, .tab-expand, and any nested spans
   * (.last-active, .model) and codicon glyphs.
   */
  .tab-container.is-active * {
    color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
  }

  /* Selection is the primary row state. Keep the lifecycle rail present, but
     neutralize its hue against the selected surface. */
  .tab-container.is-active:is(
      .status-running,
      .status-waiting,
      .status-resuming,
      .status-initializing,
      .status-starting,
      .status-failed,
      .status-error,
      .has-pending-approval
    ) {
    --stream-status-rail-color: currentColor;
  }

  /*
   * Destructive-action cue on hover: a color flip only, no hover box — the
   * row's own hover background already carries the affordance. The descendant
   * selector reaches the slotted icon past the is-active wildcard above; the
   * ::part rules strip the shared action-icon-button hover/active fill.
   */
  .tab-delete:hover,
  .tab-delete:hover *,
  .tab-delete:focus-within,
  .tab-delete:focus-within * {
    color: var(--wa-color-danger-on-quiet);
  }

  .tab-delete::part(base):hover,
  .tab-delete::part(base):active {
    border-color: transparent;
    background: transparent;
  }

  .tab-container.is-compact .tab {
    padding: var(--wa-space-3xs) var(--wa-space-3xs);
  }

  /* No compact override for .tab-delete: even the narrow rail's 48px minimum
     fits the 24px target, and shrinking it there would put the same
     sub-minimum hit area back on the layout that most needs a reliable one. */

  .tab-container.is-compact .tab-header {
    justify-content: center;
    gap: 0;
  }

  /* The compact rail reserves its remaining select width for lifecycle state.
     The accessible button name and visual tooltip retain the title, while the
     hidden title cannot shrink or clip the status glyph. */
  .tab-container.is-compact .tab-title,
  .tab-container.is-compact .tab-status-label {
    display: none;
  }

  .tab-container.is-compact .tab-status {
    inline-size: 1em;
    min-inline-size: 1em;
    max-width: none;
    overflow: visible;
  }

  .nested-stream-icon {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    flex-shrink: 0;
    margin-inline-end: var(--wa-space-3xs);
  }

  .tab-delete::part(base) {
    padding: 0;
    border-radius: var(--border-radius-small);
    background-color: color-mix(
      in srgb,
      var(--wa-color-text-quiet, var(--wa-color-text-normal)) 10%,
      transparent
    );
  }

  /* Expand/collapse chevron for parent tabs with children. This
   * component's shadow root doesn't load the shared commonViewStyles
   * sheet, so (like .tab-delete above) the reset lives locally rather
   * than through .action-icon-button's cross-component rules. */
  .tab-expand {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    min-width: 24px;
    height: 100%;
    color: var(--color-text-muted);
  }

  .tab-expand::part(base) {
    padding: 0;
    border: none;
    background: none;
  }

  .tab-expand wa-icon {
    font-size: var(--font-size-xs);
  }

  .tab-expand[aria-expanded='true'] wa-icon {
    transform: rotate(90deg);
  }

  /* The chip shares the meta row with the timestamp and model — keep it
     truncating instead of wrapping.

     Deliberately no opacity de-emphasis here: opacity on the host would
     composite every child — branch label, PR badge, diff stats, CI dot —
     and several already use the translucent --wa-color-text-quiet at
     --font-size-xs, which measures ~4.4:1 in Light Modern; multiplying that
     puts real text under the normal-text contrast floor. The row's hierarchy
     is carried the accessible way instead: .agent-name below sits at full
     --wa-color-text-normal and semibold, so it reads as primary against its
     muted siblings without dimming anything further. */
  .tab-meta worktree-chip {
    flex-shrink: 1;
  }

  /* A custom agent name is unbounded length — truncate rather than crowd
     out the worktree chip/timestamp/model sharing this row. */
  .tab-meta .agent-name {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (forced-colors: active) {
    .tab-container:is(
      .status-running,
      .status-waiting,
      .status-resuming,
      .status-initializing,
      .status-starting,
      .has-pending-approval
    ) {
      --stream-status-color: Highlight;
      --stream-status-rail-color: Highlight;
    }

    .tab-container.status-failed,
    .tab-container.status-error {
      --stream-status-color: CanvasText;
      --stream-status-rail-color: CanvasText;
    }

    .tab-container:is(.status-completed, .status-cancelled, .status-ready) {
      --stream-status-color: GrayText;
      --stream-status-rail-color: transparent;
    }

    /* System selection colors override authored status hues. The focused
       button keeps its native forced-color outline. */
    .tab-container.is-active {
      background-color: Highlight;
      color: HighlightText;
    }

    .tab-container.is-active:is(
        .status-running,
        .status-waiting,
        .status-resuming,
        .status-initializing,
        .status-starting,
        .status-failed,
        .status-error,
        .has-pending-approval
      ) {
      --stream-status-rail-color: HighlightText;
    }

    .tab-container.is-active * {
      color: HighlightText;
    }
  }
`;

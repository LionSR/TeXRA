// Third-party imports
import { css } from 'lit';

/** Styles for the individual <run-tab> row. */
export const runTabStyles = css`
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
      var(--run-status-rail-color, var(--run-status-color, transparent));
    box-sizing: border-box;
    overflow: hidden;
  }

  /* The fold spells the tone (G4); the row only maps it to a hue. */
  .tab-container.tone-running {
    --run-status-color: var(--color-success);
  }

  .tab-container.tone-danger {
    --run-status-color: var(--color-error);
  }

  .tab-container.tone-warning {
    --run-status-color: var(--color-warning);
    --run-status-rail-color: var(--color-warning);
  }

  .tab-container.tone-success .tab-status-icon {
    color: var(--color-success);
  }

  /* Finished states (completed/cancelled/ready) and unavailable keep the
     transparent default: the rail only lights up while something is
     happening or needs attention. */

  /* Pending approval — solid orange start rail. */
  .tab-container.has-pending-approval {
    --run-status-color: var(--color-warning);
    --run-status-rail-color: var(--color-chart-orange);
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
    text-align: start;
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

  /* Finished while the user was elsewhere: a quiet cue that clears once the
     run is on screen, the way an unread mark does. */
  .tab-unseen {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--wa-color-brand-fill-loud);
  }

  .tab-container.is-unseen .tab-title {
    font-weight: var(--font-weight-semibold);
  }

  /* Canonical states use only the glyph, except a pending approval, which
     also says "Needs approval".
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
    color: var(--run-status-color, var(--color-text-muted));
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
  .tab-meta .run-kind {
    margin-inline-start: var(--wa-space-2xs);
  }

  .tab-container:hover {
    background-color: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 30%,
      transparent
    );
  }

  /* The selected row's background and foreground are one pair: VS Code's
     list selection colors, or, where a host names neither (the desktop), the
     quiet brand fill with the foreground authored for it. Mixing one pair's
     background with the other's foreground is what drew dark-on-black. */
  .tab-container.is-active {
    background-color: var(
      --wa-color-list-active-bg,
      color-mix(in srgb, var(--wa-color-brand-fill-quiet) 85%, transparent)
    );
    color: var(
      --wa-color-list-active-fg,
      var(--wa-color-brand-on-quiet, var(--wa-color-text-normal))
    );
  }

  /*
   * Single descendant rule covers .tab, .tab-title, .tab-meta,
   * .tab-expand, and any nested spans
   * (.last-active, .model) and codicon glyphs.
   */
  .tab-container.is-active * {
    color: inherit;
  }

  /* Selection is the primary row state. Keep the lifecycle rail present, but
     neutralize its hue against the selected surface. */
  .tab-container.is-active:is(
      .tone-running,
      .tone-danger,
      .tone-warning,
      .has-pending-approval
    ) {
    --run-status-rail-color: currentColor;
  }

  /* A collapsed parent's descendants, in words: how many it hides and how
     many of them are running. */
  .tab-rollup {
    flex-shrink: 0;
    margin-inline-end: var(--wa-space-2xs);
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
    white-space: nowrap;
  }

  /* The fold's banner copy: the unreadable detail or the interrupted notice. */
  .tab-detail {
    width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-size-xs);
    color: var(--color-warning);
  }

  /* An interrupted row's primary action. */
  .tab-resume {
    flex-shrink: 0;
    margin-inline-start: var(--wa-space-3xs);
  }

  .tab-container.is-read-only .tab-title {
    color: var(--color-text-secondary);
  }

  .nested-run-icon {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    flex-shrink: 0;
    margin-inline-end: var(--wa-space-3xs);
  }

  /* Expand/collapse chevron for parent tabs with children. This
   * component's shadow root doesn't load the shared commonViewStyles
   * sheet, so the reset lives locally rather
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

  @media (prefers-reduced-motion: no-preference) {
    .tab-expand wa-icon {
      transition: transform var(--transition-fast);
    }
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
    .tab-container:is(.tone-running, .tone-warning, .has-pending-approval) {
      --run-status-color: Highlight;
      --run-status-rail-color: Highlight;
    }

    .tab-container.tone-danger {
      --run-status-color: CanvasText;
      --run-status-rail-color: CanvasText;
    }

    .tab-container:is(.tone-success, .tone-neutral) {
      --run-status-color: GrayText;
      --run-status-rail-color: transparent;
    }

    /* System selection colors override authored status hues. The focused
       button keeps its native forced-color outline. */
    .tab-container.is-active {
      background-color: Highlight;
      color: HighlightText;
    }

    .tab-container.is-active:is(
        .tone-running,
        .tone-danger,
        .tone-warning,
        .has-pending-approval
      ) {
      --run-status-rail-color: HighlightText;
    }

    .tab-container.is-active * {
      color: HighlightText;
    }
  }
`;

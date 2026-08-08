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
    border-inline-start: var(--border-medium) solid transparent;
    box-sizing: border-box;
    overflow: hidden;
  }

  .tab-container.status-running {
    border-inline-start-color: var(--color-success);
  }

  .tab-container.status-error,
  .tab-container.status-failed {
    border-inline-start-color: var(--color-error);
  }

  .tab-container.status-waiting,
  .tab-container.status-resuming {
    border-inline-start-color: var(--wa-color-text-link);
  }

  /* Finished states (stopped/completed/cancelled/ready) keep the
     transparent default: the rail only lights up while something is
     happening or needs attention. */

  .tab-container.status-initializing,
  .tab-container.status-starting {
    border-inline-start-color: var(--color-warning);
  }

  /* Pending approval — solid orange start rail. */
  .tab-container.has-pending-approval {
    border-inline-start-color: var(--wa-color-chart-orange, #d18616);
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

  /* Shape half of the status cue — border-left carries the hue. Renders in
     the row's own foreground so it stays legible on the selection background
     and adds no new color pair to verify. No opacity fade: this is the only
     non-color signal the status has, so it is information, not decoration. */
  .tab-status-icon {
    flex-shrink: 0;
    font-size: var(--font-size-xs);
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

  /* No compact override for .tab-delete: the narrow rail is 48px wide, which
     still fits the 24px target, and shrinking it there would put the same
     sub-minimum hit area back on the layout that most needs a reliable one. */

  .tab-container.is-compact .tab-header {
    gap: var(--wa-space-3xs);
  }

  .compact-subagent-hint {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    flex-shrink: 0;
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
`;

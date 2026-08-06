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

  /*
   * Status-rail colours. Finished / idle states (stopped, completed,
   * cancelled, ready) keep the transparent default — the rail only lights
   * up while something is running, needs attention, or has a pending
   * approval waiting.
   */
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

  .tab-container.status-initializing,
  .tab-container.status-starting {
    border-inline-start-color: var(--color-warning);
  }

  .tab-container.has-pending-approval {
    border-inline-start-color: var(--wa-color-chart-orange, #d18616);
  }

  .tab-container:hover {
    background-color: color-mix(
      in srgb,
      var(--wa-color-neutral-fill-quiet) 30%,
      transparent
    );
  }

  /* Selected row: branded fill with list-active foreground. The descendant
   * wildcard forces nested spans (.last-active, .model), codicon glyphs,
   * and every descendant to inherit the selection colour even when
   * intermediate elements define their own. */
  .tab-container.is-active {
    background-color: color-mix(
      in srgb,
      var(--wa-color-brand-fill-quiet) 85%,
      transparent
    );
    color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
  }

  .tab-container.is-active * {
    color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
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

  /*
   * Shape half of the status cue — border-inline-start on the container
   * carries the hue. Renders in the row's own foreground so it stays
   * legible on the selection background without adding a new colour pair.
   */
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

  /*
   * Reveal the metadata line on hover, focus, or selection. The agent name
   * rides a tooltip on this line when the title is the AI session one-liner.
   */
  .tab-container:hover .tab-meta,
  .tab-container:focus-within .tab-meta,
  .tab-container.is-active .tab-meta {
    display: flex;
  }

  .tab-meta .remote-agent,
  .tab-meta .stream-kind {
    margin-inline-start: var(--wa-space-2xs);
  }

  .tab-meta worktree-chip {
    flex-shrink: 1;
  }

  /*
   * Delete button. 24 px literal (not --control-size-s): the extension
   * bridges --control-size-s to 20 px for editor-chrome density, which
   * falls below WCAG 2.5.8's 24×24 minimum. The row's own select target
   * sits flush against this one — growing the hit area with a
   * pseudo-element would overlap it, making near-misses delete a session.
   * 24 px is also exactly --wa-row-height, so the row stays the same
   * height.
   */
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

  /* Reveal on hover, selection, or focus — hidden at rest. */
  .tab-container:hover .tab-delete,
  .tab-container.is-active .tab-delete,
  .tab-delete:focus-visible,
  .tab-delete:focus-within {
    opacity: 1;
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

  /*
   * Destructive colour on hover / focus — no hover box needed since the
   * row background already carries the affordance. The descendant selector
   * reaches the slotted icon past the is-active wildcard.
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

  /*
   * Expand / collapse chevron for parent tabs with children. This
   * component's shadow root does not load the shared commonViewStyles
   * sheet, so the reset lives locally.
   */
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

  /* Compact-variant overrides. */
  .tab-container.is-compact .tab {
    padding: var(--wa-space-3xs) var(--wa-space-3xs);
  }

  /*
   * No compact override for .tab-delete: the narrow rail (48 px)
   * accommodates the 24 px target, and shrinking it would re-introduce a
   * sub-minimum hit area on the layout that most needs a reliable one.
   */

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
`;

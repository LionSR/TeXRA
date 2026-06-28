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
    border-left: var(--border-medium) solid transparent;
    box-sizing: border-box;
    overflow: hidden;
  }

  /*
   * Subtle hairline below each row — keeps a refined rhythm for long
   * stream lists without imposing hard grid lines. Drops to invisible
   * on selected/hovered rows so the highlight reads cleanly.
   */
  .tab-container::after {
    content: '';
    position: absolute;
    left: var(--wa-space-3xs);
    right: var(--wa-space-3xs);
    bottom: 0;
    height: 1px;
    background: color-mix(in srgb, var(--color-border) 50%, transparent);
    pointer-events: none;
  }

  .tab-container:hover::after,
  .tab-container.is-active::after {
    opacity: 0;
  }

  .tab-container.status-running {
    border-left-color: var(--color-success);
  }

  .tab-container.status-error {
    border-left-color: var(--color-error);
  }

  .tab-container.status-waiting,
  .tab-container.status-resuming {
    border-left-color: var(--wa-color-text-link);
  }

  .tab-container.status-stopped,
  .tab-container.status-ready {
    border-left-color: var(--color-border);
  }

  .tab-container.status-initializing {
    border-left-color: var(--color-warning);
  }

  /* Pending approval — solid orange left rail. */
  .tab-container.has-pending-approval {
    border-left-color: var(--wa-color-chart-orange, #d18616);
  }

  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: var(--wa-space-2xs);
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
    gap: var(--wa-space-2xs);
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

  .tab-description {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
    opacity: var(--opacity-hover);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
    display: none;
  }

  /* Only show description when the tab has enough horizontal space */
  @container (min-width: 200px) {
    .tab-description {
      display: block;
    }
  }

  .tab-meta {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    opacity: var(--opacity-subtle);
    width: 100%;
    min-width: 0;
    overflow: hidden;
  }

  .tab-meta .remote-agent,
  .tab-meta .agent-category,
  .tab-meta .multi-file {
    margin-left: var(--wa-space-2xs);
  }

  .tab-delete {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    min-width: 20px;
    height: 20px;
    margin: 0 0 0 var(--wa-space-2xs);
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
   * .tab-description, .tab-delete, .tab-expand, and any nested spans
   * (.last-active, .model) and codicon glyphs.
   */
  .tab-container.is-active * {
    color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
  }

  /*
   * Re-apply the destructive-action cue on active tabs — the
   * descendant-wildcard above would otherwise hold the close icon on
   * the selection foreground.
   */
  .tab-container.is-active .tab-delete:hover,
  .tab-container.is-active .tab-delete:hover *,
  .tab-container.is-active .tab-delete:focus-within,
  .tab-container.is-active .tab-delete:focus-within * {
    color: var(--wa-color-danger-on-quiet);
  }

  /* Drop the dim-by-default opacity so the flipped foreground renders
   * at full contrast on the selection background. */
  .tab-container.is-active .tab-meta,
  .tab-container.is-active .tab-description {
    opacity: var(--opacity-full);
  }

  .tab-container.is-compact .tab {
    padding: var(--wa-space-2xs) var(--wa-space-3xs);
  }

  .tab-container.is-compact .tab-delete {
    width: 20px;
    min-width: 20px;
    height: 20px;
  }

  .tab-container.is-compact .tab-header {
    gap: var(--wa-space-3xs);
  }

  .compact-subagent-hint {
    font-size: var(--font-size-xs);
    opacity: var(--opacity-faint);
    flex-shrink: 0;
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

  .tab-delete:hover,
  .tab-delete:focus-within {
    color: var(--wa-color-danger-on-quiet);
  }

  /* Expand/collapse chevron for parent tabs with children */
  .tab-expand {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    min-width: 20px;
    height: 100%;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--wa-color-text-quiet, var(--wa-color-text-normal));
    opacity: var(--opacity-muted);
    padding: 0;
  }

  .tab-expand wa-icon {
    font-size: var(--font-size-xs);
  }

  .tab-expand[aria-expanded='true'] wa-icon {
    transform: rotate(90deg);
  }

  .worktree-chip-row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    width: 100%;
    margin-top: var(--wa-space-3xs);
    min-width: 0;
    overflow: hidden;
  }
`;

/** Styles for the <stream-tabs> list container. */
export const streamTabsContainerStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    flex: 1;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    min-height: 0;
    overflow: hidden;
  }

  :host([hidden]) {
    display: none;
  }

  /*
   * No own border-left: the single separator between this rail and the
   * conversation is owned by the host layout — the wa-split-panel divider
   * in the extension Progress view, and the desktop-rail border-right in
   * the desktop shell. Drawing one here too produced a doubled seam.
   */
  .tabs {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
    height: 100%;
    overflow: hidden;
    background-color: var(--background-color);
  }

  /*
   * Optional rail header band. Pins to the shared --height-header token so
   * it lines up with the conversation header in the Progress view (and the
   * desktop rail header). Rendered only when a heading is set.
   */
  .stream-tabs-header {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    box-sizing: border-box;
    min-height: var(--height-header);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .stream-tabs-title {
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold, 600);
    letter-spacing: var(--letter-spacing-caps);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .tabs-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    scrollbar-width: thin;
  }

  .tabs-content > div {
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }

  .stream-list-footer {
    flex-shrink: 0;
    border-top: var(--border-thin) solid var(--color-border);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
  }

  .stream-list-controls {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
    min-width: 0;
  }

  .agent-filter-group {
    display: flex;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs);
    flex: 1 1 auto;
    min-width: 0;
  }

  .agent-filter-group wa-radio {
    min-width: auto;
    flex: 0 0 auto;
  }

  .stream-list-actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    margin-left: auto;
  }

  .delete-all-streams {
    color: var(--color-text-secondary);
  }

  .delete-all-streams::part(base) {
    border-radius: var(--border-radius-medium);
  }

  .delete-all-streams:hover {
    color: var(--color-removed);
  }

  /* Recursive child stream nesting */
  .child-streams {
    padding-left: var(--wa-space-xs, 12px);
    border-left: var(--border-thin) solid var(--color-border);
    margin-left: var(--wa-space-2xs);
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .child-streams stream-tab {
    opacity: 1;
    transition: opacity var(--transition-fast);
  }

  .child-streams stream-tab.is-finished {
    opacity: var(--opacity-subtle, 0.5);
  }
`;

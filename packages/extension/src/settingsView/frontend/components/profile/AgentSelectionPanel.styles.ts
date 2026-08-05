/** Component-scoped styles for {@link AgentSelectionPanel}. */

import { css, type CSSResult } from 'lit';

export const agentSelectionPanelStyles: CSSResult = css`
  :host {
    display: block;
  }

  .agent-split-panel {
    display: flex;
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    min-height: 300px;
    max-height: 500px;
    overflow: hidden;
    background: var(--wa-color-surface-default);
  }

  /* --- Left: Agent list --- */
  .agent-list-pane {
    width: 30%;
    min-width: 200px;
    max-width: 300px;
    border-inline-end: var(--border-thin) solid var(--color-border);
    overflow-y: auto;
    overscroll-behavior: contain;
    flex-shrink: 0;
  }

  .agent-list-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-caps);
    background: color-mix(
      in srgb,
      var(--wa-color-surface-default) 92%,
      var(--wa-color-text-normal) 4%
    );
    border-bottom: var(--border-thin) solid var(--color-border);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .agent-list-section-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    text-transform: none;
    letter-spacing: normal;
    font-weight: normal;
  }

  .agent-list-item {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    border-inline-start: var(--border-medium) solid transparent;
  }

  /*
   * Source-tinted left rail — uses existing WA semantic colours so each
   * group gets a quiet identity cue without introducing a new palette.
   * Built-in = brand, inline = warning, custom = success, remote = neutral.
   * The hairline shows on hover/selected so the resting state stays calm.
   */
  .agent-list-item[data-source='inline']:hover,
  .agent-list-item[data-source='inline'].selected {
    border-inline-start-color: var(--wa-color-warning-fill-loud);
  }

  .agent-list-item[data-source='custom']:hover,
  .agent-list-item[data-source='custom'].selected {
    border-inline-start-color: var(--wa-color-success-fill-loud);
  }

  .agent-list-item[data-source='remote']:hover,
  .agent-list-item[data-source='remote'].selected {
    border-inline-start-color: var(--border-control);
  }

  .agent-list-item:hover {
    background: var(--wa-color-neutral-fill-quiet);
  }

  .agent-list-item.selected {
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-text-normal);
    border-inline-start-color: var(--wa-color-brand-fill-loud);
  }

  .agent-list-item.selected .agent-list-item-name,
  .agent-list-item.selected .agent-list-item-badges {
    color: inherit;
  }

  .agent-list-item.selected .agent-list-item-badges {
    opacity: var(--opacity-full);
  }

  .agent-list-item-toggle {
    flex-shrink: 0;
  }

  .agent-list-item-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--wa-font-family-mono);
  }

  .agent-list-item-badges {
    display: flex;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    opacity: var(--opacity-normal);
    flex-shrink: 0;
  }

  /* --- Right: Detail pane --- */
  .agent-detail-pane {
    flex: 1;
    overflow-y: auto;
    padding: var(--wa-space-s);
    min-width: 0;
  }

  .agent-detail-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }

  .agent-detail-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    margin-bottom: var(--wa-space-s);
  }

  .agent-detail-name {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    font-family: var(--wa-font-family-mono);
    color: var(--wa-color-text-normal);
  }

  .agent-detail-description {
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-relaxed);
    margin-bottom: var(--wa-space-s);
  }

  .agent-detail-meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--wa-space-2xs) var(--wa-space-s);
    margin-bottom: var(--wa-space-s);
    font-size: var(--font-size-sm);
  }

  .agent-detail-meta-label {
    font-weight: var(--font-weight-medium);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .agent-detail-meta-value {
    color: var(--wa-color-text-normal);
  }

  .agent-detail-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs);
  }

  wa-tag.agent-tool-badge {
    font-family: var(--wa-font-family-mono);
  }

  .agent-detail-actions {
    display: flex;
    gap: var(--wa-space-xs);
    flex-wrap: wrap;
  }

  .agent-action-btn {
    flex-shrink: 0;
  }

  .agent-count {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    background: var(--wa-color-surface-default);
  }

  .agent-detail-path {
    font-size: var(--font-size-xs);
    font-family: var(--wa-font-family-mono, monospace), monospace;
    color: var(--color-text-secondary);
    margin-bottom: var(--wa-space-s);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @container settings (max-width: 520px) {
    .agent-split-panel {
      flex-direction: column;
    }

    .agent-list-pane {
      width: 100%;
      max-width: none;
      /* A length, not a percentage: the panel sets min-/max-height but never
         height, so a percentage max-height resolves against an indefinite
         containing block and is dropped. */
      max-height: 12rem;
      /* Stacked, the list is the pane that yields space to the detail pane;
         the row layout's flex-shrink: 0 would let it starve the detail. */
      flex-shrink: 1;
      border-inline-end: 0;
      border-block-end: var(--border-thin) solid var(--color-border);
    }

    .agent-detail-pane {
      /* Without a floor, a tall list can shrink the detail pane to nothing
         inside the panel's 500px cap. */
      min-height: 8rem;
    }
  }
`;

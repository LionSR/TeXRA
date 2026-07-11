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
    border-right: var(--border-thin) solid var(--color-border);
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
    border-left: var(--border-medium) solid transparent;
    outline: none;
  }

  /*
   * Source-tinted left rail — uses existing WA semantic colours so each
   * group gets a quiet identity cue without introducing a new palette.
   * Built-in = brand, custom = success, remote = neutral. The hairline
   * shows on hover/selected so the resting state stays calm.
   */
  .agent-list-item[data-source='custom']:hover,
  .agent-list-item[data-source='custom'].selected {
    border-left-color: var(--wa-color-success-fill-loud);
  }

  .agent-list-item[data-source='remote']:hover,
  .agent-list-item[data-source='remote'].selected {
    border-left-color: var(--wa-color-text-quiet);
  }

  .agent-list-item:hover {
    background: var(--wa-color-neutral-fill-quiet);
  }

  .agent-list-item:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: -1px;
  }

  .agent-list-item.selected {
    background: var(--wa-color-brand-fill-quiet);
    color: var(--wa-color-list-active-fg, var(--wa-color-text-normal));
    border-left-color: var(--wa-color-brand-fill-loud);
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
    color: var(--color-text-secondary);
    font-style: italic;
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
    border-top: var(--border-thin) solid var(--color-border);
    background: var(--wa-color-surface-default);
  }

  wa-button.agent-count-link::part(base) {
    font-size: var(--font-size-xs);
    color: var(--wa-color-text-link);
    min-height: 0;
    padding: 0;
    border: none;
    background: transparent;
  }

  wa-button.agent-count-link::part(base):hover {
    text-decoration: underline;
  }

  .agent-empty-message {
    color: var(--color-text-secondary);
    font-style: italic;
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

  .agent-action-btn--danger::part(base) {
    color: var(--wa-color-danger-on-quiet);
    border-color: var(--wa-color-danger-on-quiet);
  }

  .agent-action-btn--danger:hover::part(base) {
    background: var(--wa-color-danger-fill-quiet);
    border-color: var(--wa-color-danger-on-quiet);
  }

  .agent-delete-confirm {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    background: var(--wa-color-danger-fill-quiet);
    border: var(--border-thin) solid var(--wa-color-danger-on-quiet);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
  }

  .agent-delete-confirm-text {
    flex: 1;
  }

  .agent-delete-confirm-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    flex-shrink: 0;
  }
`;

/** Component-scoped styles for {@link ModelSelectionList}. */

import { css, type CSSResult } from 'lit';

export const modelSelectionListStyles: CSSResult = css`
  /* Generic section heading, duplicated identically in ProviderKeyList.styles.ts
     and ApiAccessSection.styles.ts — each profile section renders its own
     bare <h2>, and the rule is too small to warrant a shared module. */
  h2 {
    color: var(--wa-color-text-normal);
    margin-top: var(--wa-space-l);
    margin-bottom: var(--wa-space-xs);
    font-size: var(--font-size-lg);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-2xs);
  }

  /* ============================================
   * Model Selection List
   * ============================================ */

  .model-selection-section {
    margin-top: var(--wa-space-l);
  }

  .model-selection-section h2 {
    margin-top: 0;
  }

  .helper-model-row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    margin-bottom: var(--wa-space-s);
  }

  .helper-model-row label {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
    white-space: nowrap;
  }

  .helper-model-select {
    flex: 1;
    max-width: 300px;
  }

  .provider-group {
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    margin-bottom: var(--wa-space-2xs);
    overflow: hidden;
  }

  .provider-group-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    width: 100%;
    background: var(--wa-color-surface-default);
    border: none;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
    font-family: inherit;
    text-align: left;
  }

  /*
   * No hover on .provider-group-header itself — only the inner
   * .provider-group-toggle button is the click target. Hovering the
   * surrounding header (which also holds the read-only key-status badge)
   * would misleadingly suggest the whole row is clickable.
   */

  .provider-group-toggle {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }

  .provider-group-toggle::part(base) {
    display: flex;
    align-items: center;
    /* wa-button's own .button part defaults to justify-content: center
     * (a centered label suits a typical button) -- override it here since
     * this button's content is a left-aligned row (chevron, name, count),
     * matching the API Configuration provider rows above it. */
    justify-content: flex-start;
    width: 100%;
    padding: var(--wa-space-xs);
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .provider-group-toggle::part(base):hover {
    background: var(--wa-color-neutral-fill-quiet);
  }

  .provider-group-toggle:focus-visible::part(base) {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: var(--border-thin);
    border-radius: var(--border-radius-small);
  }

  .provider-group-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-right: var(--wa-space-2xs);
    transition: transform var(--transition-fast);
    color: var(--color-text-secondary);
  }

  .provider-group-chevron.expanded {
    transform: rotate(90deg);
  }

  .provider-group-name {
    font-weight: var(--font-weight-medium);
    flex: 1;
    min-width: 0;
  }

  .provider-group-count {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .provider-group-actions {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding-right: var(--wa-space-xs);
    white-space: nowrap;
  }

  .provider-group-key-status {
    flex-shrink: 0;
  }

  .provider-group-content {
    border-top: var(--border-thin) solid var(--color-border);
    padding: var(--wa-space-2xs) 0;
  }

  .model-row {
    display: flex;
    align-items: center;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    gap: var(--wa-space-xs);
  }

  .model-row wa-switch {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .short-names-toggle {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    margin-bottom: var(--wa-space-xs);
    font-size: var(--font-size-sm);
  }

  .short-names-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .model-name {
    font-family: var(--wa-font-family-mono);
    white-space: nowrap;
  }

  .model-shortname {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .model-metadata {
    display: flex;
    gap: var(--wa-space-xs);
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
    white-space: nowrap;
    margin-left: auto;
  }

  .reasoning-level-select {
    flex-shrink: 0;
    width: 120px;
    font-size: var(--font-size-xs);
  }

  wa-button.deprecated-toggle {
    width: 100%;
  }

  wa-button.deprecated-toggle::part(base) {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    justify-content: flex-start;
    border: none;
    background: transparent;
  }

  wa-button.deprecated-toggle::part(base):hover {
    color: var(--wa-color-text-normal);
    background: var(--wa-color-neutral-fill-quiet);
  }

  .deprecated-models {
    border-top: var(--border-thin) solid var(--color-border);
    background: var(--wa-color-surface-lowered);
  }

  /* Unavailable model rows (not in relay allowlist) */
  .model-row--unavailable {
    opacity: var(--opacity-disabled);
  }

  /**
   * Inline icon following a model row's name. Variants set --_icon-color;
   * the base resolves to secondary text when no variant is applied.
   */
  .model-row-icon {
    font-size: var(--font-size-xs);
    margin-left: var(--wa-space-3xs);
    color: var(--_icon-color, var(--color-text-secondary));
  }

  .model-row-icon--warning {
    --_icon-color: var(
      --wa-color-list-warning-fg,
      var(--wa-color-warning-on-quiet)
    );
  }
`;

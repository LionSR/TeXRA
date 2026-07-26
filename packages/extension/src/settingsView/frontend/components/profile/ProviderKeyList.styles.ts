/** Component-scoped styles for {@link ProviderKeyList}. */

import { css, type CSSResult } from 'lit';

export const providerKeyListStyles: CSSResult = css`
  /* ============================================
   * Provider Keys Table
   * ============================================ */

  .provider-keys-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: var(--wa-space-xs);
  }

  .provider-keys-table th,
  .provider-keys-table td {
    padding: var(--wa-space-xs);
    text-align: left;
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .provider-keys-table th {
    background: var(--wa-color-surface-default);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
    position: sticky;
    top: 0;
  }

  /* ============================================
   * Provider Keys Section
   * ============================================ */

  .provider-keys-section {
    margin-top: var(--wa-space-l);
  }

  .provider-keys-section h2 {
    margin-top: 0;
  }

  .provider-keys-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--wa-space-xs);
    line-height: var(--line-height-normal);
  }

  .provider-name {
    font-weight: var(--font-weight-medium);
    white-space: nowrap;
  }

  .provider-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    white-space: nowrap;
  }

  /* Global streaming toggle */
  .global-streaming-toggle {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    margin-bottom: var(--wa-space-xs);
    padding: var(--wa-space-xs);
    background: var(--wa-form-control-background-color);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
  }

  .global-streaming-toggle wa-switch {
    font-weight: var(--font-weight-medium);
  }

  .global-streaming-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  /* Provider row expand/collapse — wa-button rotates its chevron when expanded */
  wa-button.provider-expand-btn::part(base) {
    color: var(--color-text-secondary);
    transition: transform var(--transition-fast);
  }

  wa-button.provider-expand-btn.expanded::part(base) {
    transform: rotate(90deg);
  }

  .provider-name-cell {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  /* Provider detail row (collapsible settings) */
  .provider-detail-row td {
    padding: 0 var(--wa-space-xs) var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .provider-settings {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-xs);
    background: var(--wa-color-surface-lowered);
    border-radius: var(--border-radius);
  }

  .provider-setting {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
  }

  .provider-setting label {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    min-width: 120px;
  }

  .provider-setting wa-switch {
    font-size: var(--font-size-sm);
    min-width: 120px;
  }

  .provider-setting--block {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
  }

  .provider-setting-description,
  .provider-setting-warning {
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    padding-left: var(--wa-space-l);
  }

  .provider-setting-description {
    color: var(--color-text-secondary);
  }

  .provider-setting-warning {
    color: var(
      --texra-inputValidation-warningForeground,
      var(--wa-color-warning-on-quiet)
    );
  }

  wa-button.provider-setting-link {
    margin-left: var(--wa-space-2xs);
  }

  .endpoint-input {
    flex: 1;
    max-width: 400px;
  }
`;

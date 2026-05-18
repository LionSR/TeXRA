// Third-party imports
import { css, type CSSResult } from 'lit';

export const profileViewStyles: CSSResult = css`
  h2 {
    color: var(--wa-color-text-normal);
    margin-top: var(--wa-space-l);
    margin-bottom: var(--wa-space-xs);
    font-size: var(--font-size-lg);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-2xs);
  }

  .profile-container {
    max-width: 1000px;
    margin: 0 auto;
  }

  .not-authenticated {
    text-align: center;
    padding: var(--wa-space-l);
  }

  .not-authenticated p {
    margin-bottom: var(--wa-space-l);
    color: var(--color-text-secondary);
  }

  .remote-agents-section {
    margin-top: var(--wa-space-l);
  }

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

  /* Profile-specific badge modifiers (base category styles from @shared/styles) */
  .category-badge {
    text-transform: capitalize;
  }

  .visibility-badge {
    text-transform: lowercase;
  }

  .badge.visibility-badge.public {
    background: var(--wa-color-success-fill-loud);
    color: var(--wa-color-brand-on-loud);
  }

  .badge.visibility-badge.custom {
    background: var(--wa-color-neutral-fill-quiet);
    color: var(--wa-color-neutral-on-quiet);
  }

  .select-btn {
    white-space: nowrap;
  }

  /* ============================================
   * API Access Options
   * ============================================ */

  .api-access-section {
    margin-top: var(--wa-space-l);
    margin-bottom: var(--wa-space-l);
  }

  .api-access-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--wa-space-xs);
    line-height: var(--line-height-normal);
  }

  /* wa-radio-group provides layout + keyboard navigation; the per-option card
     chrome (border, background, hover) is rendered on each <wa-radio>. */
  wa-radio-group.api-access-options {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
  }

  wa-radio.api-access-option {
    align-items: flex-start;
    padding: var(--wa-space-xs);
    background: var(--wa-form-control-background-color);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
  }

  wa-radio.api-access-option:hover {
    border-color: var(--wa-color-focus);
  }

  wa-radio.api-access-option[checked] {
    border-color: var(--wa-color-focus);
    background: var(--wa-color-neutral-fill-quiet);
  }

  .api-access-support {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .api-access-support-icon {
    flex-shrink: 0;
    margin-top: var(--wa-space-3xs);
    color: var(--wa-color-chart-red, var(--wa-color-danger-on-quiet));
  }

  .api-access-support a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }

  .api-access-support a:hover {
    color: var(--wa-color-text-link-active);
    text-decoration: underline;
  }

  .option-content {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
  }

  .option-title {
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .option-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
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

  wa-button.provider-setting-link::part(base) {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-link);
    min-height: 0;
    padding: 0;
    border: none;
    background: transparent;
  }

  wa-button.provider-setting-link::part(base):hover {
    text-decoration: underline;
  }

  .endpoint-input {
    flex: 1;
    max-width: 400px;
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

  .model-selection-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--wa-space-xs);
    line-height: var(--line-height-normal);
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
   * surrounding header (which also contains key-action buttons) would
   * misleadingly suggest the whole row is clickable.
   */

  .provider-group-toggle {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    padding: var(--wa-space-xs);
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  .provider-group-toggle:hover {
    background: var(--wa-color-neutral-fill-quiet);
  }

  .provider-group-toggle:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
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

  .provider-group-key-button {
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

  .model-row wa-checkbox {
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
   * Mirrors the tinted-badge --_tint pattern in shared badgeStyles.
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

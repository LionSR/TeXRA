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

  .profile-info {
    margin-bottom: var(--wa-space-l);
  }

  .profile-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--wa-space-xs);
  }

  .info-row {
    margin: var(--wa-space-xs) 0;
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
  }

  .label {
    font-weight: var(--font-weight-bold);
    color: var(--texra-textPreformat-foreground);
    min-width: 80px;
  }

  .value {
    color: var(--wa-color-text-normal);
  }

  wa-tag.tier-badge {
    text-transform: uppercase;
    font-weight: var(--font-weight-semibold);
  }

  .profile-notice {
    margin: var(--wa-space-2xs) 0 var(--wa-space-xs);
    color: var(--texra-descriptionForeground, var(--color-text-secondary));
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    max-width: 640px;
  }

  .profile-notice code {
    font-family: var(--texra-editor-font-family, monospace), monospace;
    font-size: 0.95em;
    padding: 0 var(--wa-space-3xs);
    border-radius: var(--border-radius-small);
    background: var(--texra-textBlockQuote-background);
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

  .provider-keys-table tbody tr:hover {
    background: var(--wa-color-neutral-fill-quiet);
  }

  /* Profile-specific badge modifiers (base category styles from @shared/styles) */
  .category-badge {
    text-transform: capitalize;
  }

  .visibility-badge {
    text-transform: lowercase;
  }

  .badge.visibility-badge.public {
    background: var(--texra-testing-iconPassed);
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

  .api-access-options {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
  }

  .api-access-option {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-xs);
    background: var(--wa-form-control-background-color);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    cursor: pointer;
    transition: border-color var(--transition-normal);
  }

  .api-access-option:hover {
    border-color: var(--wa-color-focus);
  }

  .api-access-option:has(input:checked) {
<<<<<<< HEAD
    border-color: var(--texra-focusBorder);
    background: var(--wa-color-neutral-fill-quiet);
=======
    border-color: var(--wa-color-focus);
    background: var(--texra-list-hoverBackground);
>>>>>>> origin/main
  }

  .api-access-option input[type='radio'] {
    margin-top: var(--wa-space-3xs);
    accent-color: var(--wa-color-focus);
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
    margin-top: 2px;
    color: var(--texra-charts-red, var(--wa-color-danger-on-quiet));
  }

  .api-access-support a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }

  .api-access-support a:hover {
    color: var(--texra-textLink-activeForeground);
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

  .global-streaming-toggle wa-checkbox {
    font-weight: var(--font-weight-medium);
  }

  .global-streaming-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  /* Provider row expand/collapse */
  .provider-expand-btn {
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    padding: 0;
    transition: transform var(--transition-fast);
  }

  .provider-expand-btn:hover {
    color: var(--wa-color-text-normal);
  }

  .provider-expand-btn:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .provider-expand-btn.expanded {
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
    background: var(--texra-textBlockQuote-background);
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

  .provider-setting wa-checkbox {
    font-size: var(--font-size-sm);
    min-width: 120px;
  }

  .provider-setting--block {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
  }

  .provider-setting-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    padding-left: 22px;
  }

  .provider-setting-warning {
    color: var(
      --texra-inputValidation-warningForeground,
      var(--texra-editorWarning-foreground)
    );
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    padding-left: 22px;
  }

  .provider-setting-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-link);
    cursor: pointer;
    text-decoration: none;
    margin-left: var(--wa-space-2xs);
  }

  .provider-setting-link:hover {
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

  .provider-group-header:hover {
    background: var(--wa-color-neutral-fill-quiet);
  }

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

  .model-row:hover {
    background: var(--wa-color-neutral-fill-quiet);
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
    font-family: var(--texra-editor-font-family);
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

  .deprecated-toggle {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-family: inherit;
    width: 100%;
    text-align: left;
  }

  .deprecated-toggle:hover {
<<<<<<< HEAD
    color: var(--texra-foreground);
    background: var(--wa-color-neutral-fill-quiet);
=======
    color: var(--wa-color-text-normal);
    background: var(--texra-list-hoverBackground);
>>>>>>> origin/main
  }

  .deprecated-toggle:focus-visible {
    outline: var(--border-thin) solid var(--wa-color-focus);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .deprecated-models {
    border-top: var(--border-thin) solid var(--color-border);
    background: var(--texra-textBlockQuote-background);
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
      --texra-list-warningForeground,
      var(--texra-editorWarning-foreground)
    );
  }
`;

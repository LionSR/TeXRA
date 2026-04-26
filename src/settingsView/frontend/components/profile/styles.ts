// Third-party imports
import { css, type CSSResult } from 'lit';

export const profileViewStyles: CSSResult = css`
  h2 {
    color: var(--vscode-foreground);
    margin-top: var(--spacing-xlarge);
    margin-bottom: var(--spacing-medium);
    font-size: var(--font-size-lg);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--spacing-small);
  }

  .profile-container {
    max-width: 1000px;
    margin: 0 auto;
  }

  .profile-info {
    margin-bottom: var(--spacing-xlarge);
  }

  .profile-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--spacing-medium);
  }

  .info-row {
    margin: var(--spacing-medium) 0;
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
  }

  .label {
    font-weight: var(--font-weight-bold);
    color: var(--vscode-textPreformat-foreground);
    min-width: 80px;
  }

  .value {
    color: var(--vscode-foreground);
  }

  .tier-badge {
    text-transform: uppercase;
    font-weight: var(--font-weight-semibold);
  }

  .profile-notice {
    margin: var(--spacing-small) 0 var(--spacing-medium);
    color: var(--vscode-descriptionForeground, var(--color-text-secondary));
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    max-width: 640px;
  }

  .profile-notice code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.95em;
    padding: 0 var(--spacing-tiny);
    border-radius: var(--border-radius-small);
    background: var(--vscode-textBlockQuote-background);
  }

  .tier-badge.free {
    background: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground);
  }

  .tier-badge.max {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .tier-badge.ultra {
    background: var(--vscode-textLink-activeForeground);
    color: var(--vscode-button-foreground);
  }

  .not-authenticated {
    text-align: center;
    padding: var(--spacing-xlarge);
  }

  .not-authenticated p {
    margin-bottom: var(--spacing-xlarge);
    color: var(--color-text-secondary);
  }

  .remote-agents-section {
    margin-top: var(--spacing-xlarge);
  }

  /* ============================================
   * Provider Keys Table
   * ============================================ */

  .provider-keys-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: var(--spacing-medium);
  }

  .provider-keys-table th,
  .provider-keys-table td {
    padding: var(--spacing-medium);
    text-align: left;
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .provider-keys-table th {
    background: var(--vscode-editor-background);
    font-weight: var(--font-weight-semibold);
    color: var(--vscode-foreground);
    position: sticky;
    top: 0;
  }

  .provider-keys-table tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  /* Profile-specific badge modifiers (base category styles from @shared/styles) */
  .category-badge {
    text-transform: capitalize;
  }

  .visibility-badge {
    text-transform: lowercase;
  }

  .badge.visibility-badge.public {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-button-foreground);
  }

  .badge.visibility-badge.custom {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .select-btn {
    white-space: nowrap;
  }

  /* ============================================
   * API Access Options
   * ============================================ */

  .api-access-section {
    margin-top: var(--spacing-xlarge);
    margin-bottom: var(--spacing-xlarge);
  }

  .api-access-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--spacing-medium);
    line-height: var(--line-height-normal);
  }

  .api-access-options {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-medium);
  }

  .api-access-option {
    display: flex;
    align-items: flex-start;
    gap: var(--spacing-medium);
    padding: var(--spacing-medium);
    background: var(--vscode-input-background);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    cursor: pointer;
    transition: border-color var(--transition-normal);
  }

  .api-access-option:hover {
    border-color: var(--vscode-focusBorder);
  }

  .api-access-option:has(input:checked) {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground);
  }

  .api-access-option input[type='radio'] {
    margin-top: var(--spacing-tiny);
    accent-color: var(--vscode-focusBorder);
  }

  .option-content {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small);
  }

  .option-title {
    font-weight: var(--font-weight-semibold);
    color: var(--vscode-foreground);
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
    margin-top: var(--spacing-xlarge);
  }

  .provider-keys-section h2 {
    margin-top: 0;
  }

  .provider-keys-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--spacing-medium);
    line-height: var(--line-height-normal);
  }

  .provider-name {
    font-weight: var(--font-weight-medium);
    white-space: nowrap;
  }

  .key-status-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-small);
    font-size: var(--font-size-sm);
    padding: var(--spacing-tiny) var(--spacing-small);
    border-radius: var(--border-radius);
  }

  .key-status-badge.set {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-button-foreground);
  }

  .key-status-badge.env {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .key-status-badge.not-set {
    background: var(--vscode-input-background);
    color: var(--color-text-secondary);
    border: var(--border-thin) solid var(--color-border);
  }

  .provider-actions {
    display: flex;
    gap: var(--spacing-small);
    white-space: nowrap;
  }

  /* Global streaming toggle */
  .global-streaming-toggle {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    margin-bottom: var(--spacing-medium);
    padding: var(--spacing-medium);
    background: var(--vscode-input-background);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
  }

  .global-streaming-toggle vscode-checkbox {
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
    color: var(--vscode-foreground);
  }

  .provider-expand-btn:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .provider-expand-btn.expanded {
    transform: rotate(90deg);
  }

  .provider-name-cell {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  /* Provider detail row (collapsible settings) */
  .provider-detail-row td {
    padding: 0 var(--spacing-medium) var(--spacing-medium);
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .provider-settings {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-medium);
    padding: var(--spacing-medium);
    background: var(--vscode-textBlockQuote-background);
    border-radius: var(--border-radius);
  }

  .provider-setting {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
  }

  .provider-setting label {
    font-size: var(--font-size-sm);
    color: var(--vscode-foreground);
    min-width: 120px;
  }

  .provider-setting vscode-checkbox {
    font-size: var(--font-size-sm);
    min-width: 120px;
  }

  .provider-setting--block {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--spacing-small);
  }

  .provider-setting-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    padding-left: 22px;
  }

  .provider-setting-warning {
    color: var(
      --vscode-inputValidation-warningForeground,
      var(--vscode-editorWarning-foreground)
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
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    margin-left: var(--spacing-small);
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
    margin-top: var(--spacing-xlarge);
  }

  .model-selection-section h2 {
    margin-top: 0;
  }

  .model-selection-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--spacing-medium);
    line-height: var(--line-height-normal);
  }

  .helper-model-row {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    margin-bottom: var(--spacing-large);
  }

  .helper-model-row label {
    font-weight: var(--font-weight-medium);
    color: var(--vscode-foreground);
    white-space: nowrap;
  }

  .helper-model-select {
    flex: 1;
    max-width: 300px;
  }

  .provider-group {
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    margin-bottom: var(--spacing-small);
    overflow: hidden;
  }

  .provider-group-header {
    display: flex;
    align-items: center;
    width: 100%;
    padding: var(--spacing-medium);
    background: var(--vscode-editor-background);
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-family: inherit;
    text-align: left;
  }

  .provider-group-header:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .provider-group-header:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .provider-group-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-right: var(--spacing-small);
    transition: transform var(--transition-fast);
    color: var(--color-text-secondary);
  }

  .provider-group-chevron.expanded {
    transform: rotate(90deg);
  }

  .provider-group-name {
    font-weight: var(--font-weight-medium);
    flex: 1;
  }

  .provider-group-count {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .provider-group-content {
    border-top: var(--border-thin) solid var(--color-border);
    padding: var(--spacing-small) 0;
  }

  .model-row {
    display: flex;
    align-items: center;
    padding: var(--spacing-small) var(--spacing-medium);
    gap: var(--spacing-medium);
  }

  .model-row:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .model-row vscode-checkbox {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .short-names-toggle {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    margin-bottom: var(--spacing-medium);
    font-size: var(--font-size-sm);
  }

  .short-names-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .model-name {
    font-family: var(--vscode-editor-font-family);
    white-space: nowrap;
  }

  .model-shortname {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .model-metadata {
    display: flex;
    gap: var(--spacing-medium);
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
    gap: var(--spacing-small);
    padding: var(--spacing-small) var(--spacing-medium);
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
    color: var(--vscode-foreground);
    background: var(--vscode-list-hoverBackground);
  }

  .deprecated-toggle:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .deprecated-models {
    border-top: var(--border-thin) solid var(--color-border);
    background: var(--vscode-textBlockQuote-background);
  }

  /* Unavailable model rows (not in relay allowlist) */
  .model-row--unavailable {
    opacity: var(--opacity-disabled);
  }

  .model-key-icon {
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    margin-left: var(--spacing-tiny);
  }

  .model-warning-icon {
    font-size: var(--font-size-xs);
    color: var(--vscode-list-warningForeground, var(--color-text-secondary));
    margin-left: var(--spacing-tiny);
  }
`;

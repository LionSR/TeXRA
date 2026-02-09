// Third-party imports
import { css, unsafeCSS, type CSSResult } from 'lit';
import { searchStyles, historyListStyles } from '@shared/styles';

export const settingsViewStyles: CSSResult = css`
  /* Import shared history/search styles */
  ${unsafeCSS(searchStyles.cssText)}
  ${unsafeCSS(historyListStyles.cssText)}
  /* Settings header bar */
  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-medium) var(--spacing-large);
    background: var(--vscode-sideBar-background);
    border-bottom: var(--border-thin) solid var(--color-border);
    margin-bottom: var(--spacing-medium);
  }

  .settings-header-user {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
  }

  .settings-header-user .codicon {
    font-size: var(--font-size-lg);
    opacity: var(--opacity-subtle);
  }

  .settings-header-info {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-tiny);
  }

  .settings-header-email {
    font-weight: 500;
    color: var(--vscode-foreground);
  }

  .settings-header-tier {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .settings-header-signed-out {
    color: var(--color-text-secondary);
  }

  .settings-header-actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }

  /* Tab container */
  .settings-tab-container {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  vscode-tabs {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  vscode-tab-panel {
    flex: 1;
    overflow: auto;
    padding: var(--spacing-large);
  }

  /* Memory view styles */
  .memory-view-container {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-medium);
  }

  .memory-description {
    margin: 0 0 var(--spacing-medium) 0;
  }

  /* Profile view styles */
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
    font-weight: bold;
    color: var(--vscode-textPreformat-foreground);
    min-width: 80px;
  }

  .value {
    color: var(--vscode-foreground);
  }

  .tier-badge {
    text-transform: uppercase;
    font-weight: 600;
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
    background: linear-gradient(
      135deg,
      var(--vscode-textLink-foreground) 0%,
      var(--vscode-textLink-activeForeground) 100%
    );
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

  .badge.visibility-badge.public {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-button-foreground);
  }

  .badge.visibility-badge.custom {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .badge.multi-output-badge.supported {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-button-foreground);
  }

  .badge.multi-output-badge.not-supported {
    background: var(--vscode-input-background);
    color: var(--color-text-secondary);
    border: var(--border-thin) solid var(--color-border);
  }

  .select-btn {
    white-space: nowrap;
  }

  .api-access-section {
    margin-top: var(--spacing-xlarge);
    margin-bottom: var(--spacing-xlarge);
  }

  .api-access-description {
    color: var(--color-text-secondary);
    margin-bottom: var(--spacing-medium);
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
    transition: border-color 0.2s ease;
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
    font-weight: 600;
    color: var(--vscode-foreground);
  }

  .option-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
`;

// Third-party imports
import { css, type CSSResult } from 'lit';

export const profileViewStyles: CSSResult = css`
  h2 {
    color: var(--vscode-foreground);
    margin-top: var(--spacing-xlarge);
    margin-bottom: var(--spacing-medium);
    font-size: 1.2em;
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

  .agents-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: var(--spacing-medium);
  }

  .agents-table th,
  .agents-table td {
    padding: var(--spacing-medium);
    text-align: left;
    border-bottom: var(--border-thin) solid var(--color-border);
  }

  .agents-table th {
    background: var(--vscode-editor-background);
    font-weight: 600;
    color: var(--vscode-foreground);
    position: sticky;
    top: 0;
  }

  .agents-table tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .agent-name {
    font-weight: 500;
    color: var(--color-text-link);
    white-space: nowrap;
  }

  .agent-description {
    color: var(--vscode-foreground);
    max-width: 300px;
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

  .category-badge {
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

  .no-agents {
    color: var(--color-text-secondary);
    font-style: italic;
    padding: var(--spacing-xlarge);
    text-align: center;
  }

  .loading {
    color: var(--color-text-secondary);
    font-style: italic;
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
    margin-top: 3px;
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

  .model-access-info {
    margin-top: var(--spacing-medium);
  }

  .model-access-error {
    margin-top: var(--spacing-medium);
    padding: var(--spacing-small) var(--spacing-medium);
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-inputValidation-errorForeground);
    border: var(--border-thin) solid var(--vscode-inputValidation-errorBorder);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
  }

  .model-access-summary {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    padding: var(--spacing-small) var(--spacing-medium);
    background: var(--vscode-textBlockQuote-background);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    list-style: none;
  }

  .model-access-summary::-webkit-details-marker {
    display: none;
  }

  .model-access-summary::after {
    content: '';
    margin-left: auto;
    border: solid var(--color-text-secondary);
    border-width: 0 1.5px 1.5px 0;
    padding: 3px;
    transform: rotate(45deg);
    opacity: 0.6;
    transition: transform 0.2s ease;
  }

  .model-access-info[open] .model-access-summary::after {
    transform: rotate(-135deg);
  }

  .model-access-summary:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .separator {
    opacity: 0.5;
  }

  .models-list-container {
    margin-top: var(--spacing-small);
    padding: var(--spacing-small) var(--spacing-medium);
    background: var(--vscode-textBlockQuote-background);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    line-height: 1.6;
  }
`;

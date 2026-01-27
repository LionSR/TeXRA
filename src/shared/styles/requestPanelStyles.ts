/**
 * Shared request panel styles for progress view prompts.
 *
 * Ports legacy progressView request styles (approval, retry, workflow proposals)
 * into Lit-compatible CSS for shadow DOM usage.
 */

import { css, type CSSResult } from 'lit';

export const requestPanelStyles: CSSResult = css`
  .approval-requests,
  .bash-approval-requests,
  .retry-requests,
  .workflow-proposals {
    margin: var(--spacing-large) 0;
    padding: var(--spacing-large);
    border-radius: var(--border-radius-large);
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.12));
    display: flex;
    flex-direction: column;
    gap: var(--spacing-large);
  }

  .approval-requests__header,
  .bash-approval-requests__header,
  .retry-requests__header,
  .workflow-proposals__header {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .approval-requests__list,
  .bash-approval-requests__list,
  .retry-requests__list,
  .workflow-proposals__list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-large);
  }

  .approval-request,
  .bash-approval-request,
  .retry-request,
  .workflow-proposal {
    display: flex;
    flex-direction: column;
    border-radius: var(--border-radius);
    border: var(--border-thin) solid var(--vscode-editorHoverWidget-border);
    background: var(--vscode-editorHoverWidget-background);
    padding: var(--spacing-large);
    gap: var(--spacing-medium);
  }

  .approval-request__details,
  .bash-approval-request__details,
  .retry-request__details,
  .workflow-proposal__details {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small);
  }

  .approval-request__meta,
  .retry-request__meta {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    flex-wrap: wrap;
  }

  .approval-request__actions,
  .bash-approval-request__actions,
  .retry-request__actions,
  .workflow-proposal__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-small);
  }

  .approval-request__actions::part(container),
  .bash-approval-request__actions::part(container),
  .retry-request__actions::part(container),
  .workflow-proposal__actions::part(container) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-small);
  }

  .approval-request__actions vscode-toolbar-button,
  .bash-approval-request__actions vscode-toolbar-button,
  .retry-request__actions vscode-toolbar-button,
  .workflow-proposal__actions vscode-toolbar-button {
    min-width: auto;
  }

  .approval-request__actions vscode-toolbar-button::part(control),
  .bash-approval-request__actions vscode-toolbar-button::part(control),
  .retry-request__actions vscode-toolbar-button::part(control),
  .workflow-proposal__actions vscode-toolbar-button::part(control) {
    justify-content: flex-start;
    gap: var(--spacing-small);
  }

  /* Approval requests */
  .approval-requests {
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-editor-background);
  }

  .approval-requests__header .codicon {
    color: var(--vscode-editor-foreground);
  }

  .approval-request__actions vscode-toolbar-button {
    flex: 1 1 12rem;
  }

  .approval-request__path {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm);
    color: var(--color-text-link);
    word-break: break-word;
  }

  .approval-request__diff {
    display: inline-flex;
    align-items: baseline;
    gap: var(--spacing-small);
  }

  .approval-request__diff-added,
  .approval-request__diff-removed {
    font-size: var(--font-size-xs);
  }

  .approval-request__diff-added {
    color: var(--color-added);
  }

  .approval-request__diff-removed {
    color: var(--color-removed);
  }

  .approval-request__diff-label {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
    opacity: 0.9;
  }

  .approval-request__actions .diff-dropdown {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: 1 1 12rem;
  }

  .approval-request__actions .diff-dropdown .diff-main-button {
    flex: 1;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .approval-request__actions .diff-dropdown .diff-dropdown-trigger {
    flex: 0 0 auto;
    width: 20px;
    min-width: 20px;
    padding: 0;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid
      var(--vscode-button-separator, var(--vscode-input-border));
  }

  .approval-request__actions .diff-dropdown .diff-dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    left: 0;
    z-index: 100;
    min-width: 150px;
  }

  .approval-request__actions
    .diff-dropdown-trigger[aria-expanded='true']
    .codicon-chevron-down {
    transform: rotate(180deg);
  }

  .approval-request__feedback {
    margin-top: var(--spacing-small);
  }

  .approval-request__feedback-input {
    width: 100%;
  }

  .approval-request--feedback-active
    .approval-request__actions
    vscode-toolbar-button[data-action='reject']::part(control) {
    color: var(--vscode-inputValidation-warningBorder);
  }

  /* Bash approval requests */
  .bash-approval-requests {
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-editor-background);
  }

  .bash-approval-requests__header .codicon {
    color: var(--vscode-terminal-ansiYellow);
  }

  .bash-approval-request__command {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm);
  }

  .bash-approval-request__command code {
    display: block;
    padding: var(--spacing-medium);
    background: var(--vscode-textCodeBlock-background);
    border-radius: var(--border-radius);
    color: var(--vscode-terminal-foreground);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  .bash-approval-request__actions vscode-toolbar-button {
    flex: 1 1 12rem;
  }

  /* Retry requests */
  .retry-requests {
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-editor-background);
  }

  .retry-requests__header .codicon {
    color: var(--color-warning);
  }

  .retry-request__actions vscode-toolbar-button {
    flex: 1 1 8rem;
  }

  .retry-request__operation {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm);
    color: var(--vscode-editor-foreground);
    font-weight: 500;
  }

  .retry-request__error {
    font-size: var(--font-size-xs);
    color: var(--color-error);
    word-break: break-word;
    max-height: 4em;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .retry-request__error-details {
    margin-top: var(--spacing-tiny);
    font-size: var(--font-size-xs);
  }

  .retry-request__error-summary {
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: var(--spacing-tiny);
    user-select: none;
  }

  .retry-request__error-summary:hover {
    color: var(--vscode-foreground);
  }

  .retry-request__error-summary .toggle-icon {
    transition: transform 0.2s ease;
  }

  .retry-request__error-details[open]
    .retry-request__error-summary
    .toggle-icon {
    transform: rotate(90deg);
  }

  .retry-request__error-body {
    margin-top: var(--spacing-tiny);
    padding: var(--spacing-small);
    background: var(--vscode-textBlockQuote-background, rgba(0, 0, 0, 0.1));
    border-radius: var(--border-radius-small);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
  }

  .retry-request--relay .retry-request__operation {
    color: var(--vscode-editorWarning-foreground, #ff8c00);
  }

  .retry-request--relay::before {
    content: '';
    position: absolute;
    left: 0;
    inset-block: 0;
    width: 3px;
    background: var(--vscode-editorWarning-foreground, #ff8c00);
    border-radius: var(--border-radius-small) 0 0 var(--border-radius-small);
  }

  /* Workflow proposals */
  .workflow-proposals {
    border: 1px solid var(--vscode-inputValidation-infoBorder);
    background: var(--vscode-inputValidation-infoBackground);
  }

  .workflow-proposals__header .codicon {
    color: var(--vscode-textLink-foreground);
  }

  .workflow-proposal__actions vscode-toolbar-button {
    flex: 1 1 6rem;
  }

  .workflow-proposal {
    position: relative;
  }

  .workflow-proposal__header-row {
    display: flex;
    align-items: baseline;
    gap: var(--spacing-medium);
    flex-wrap: wrap;
  }

  .workflow-proposal__category-badge {
    font-size: var(--font-size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: var(--border-radius);
    white-space: nowrap;
  }

  .workflow-proposal__category-badge--workflow {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .workflow-proposal__category-badge--tool-use {
    background: var(--vscode-textLink-foreground);
    color: var(--vscode-editor-background);
  }

  .workflow-proposal__agent {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size);
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
  }

  .workflow-proposal__model {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .workflow-proposal__model::before {
    content: '\u2022';
    margin-right: var(--spacing-small);
  }

  .workflow-proposal__instruction {
    font-size: var(--font-size-sm);
    color: var(--vscode-editor-foreground);
    word-break: break-word;
    white-space: pre-wrap;
    max-height: 12em;
    overflow-y: auto;
    line-height: 1.4;
    padding: var(--spacing-small) 0;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
  }

  .workflow-proposal__files {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small);
    margin-top: var(--spacing-small);
  }

  .workflow-proposal__files > div {
    font-size: var(--font-size-sm);
    color: var(--vscode-editor-foreground);
    line-height: 1.4;
  }

  .workflow-proposal__file-label {
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .workflow-proposal__file-name {
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
  }

  .workflow-proposal__file-name:hover {
    text-decoration: underline;
    color: var(
      --vscode-textLink-activeForeground,
      var(--vscode-textLink-foreground)
    );
  }

  .workflow-proposal__input-files .workflow-proposal__file-label {
    color: var(--vscode-editor-foreground);
  }

  .workflow-proposal__output-files .workflow-proposal__file-label {
    color: var(--vscode-textLink-foreground);
  }

  .workflow-proposal__actions
    vscode-toolbar-button[data-action='approve']::part(control) {
    color: var(--vscode-testing-iconPassed);
  }

  .workflow-proposal__actions
    vscode-toolbar-button[data-action='reject']::part(control) {
    color: var(--vscode-testing-iconFailed);
  }

  .workflow-proposal__actions
    vscode-toolbar-button[data-action='setup']::part(control) {
    color: var(--vscode-textLink-foreground);
  }

  .workflow-proposal__feedback {
    margin-top: var(--spacing-small);
  }

  .workflow-proposal__feedback-input {
    width: 100%;
  }

  .workflow-proposal--feedback-active
    .workflow-proposal__actions
    vscode-toolbar-button[data-action='reject']::part(control) {
    color: var(--vscode-inputValidation-warningBorder);
  }
`;

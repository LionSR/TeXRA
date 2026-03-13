import { css, unsafeCSS, type CSSResult } from 'lit';

/**
 * Shared selector groups for :is() consolidation.
 * When adding a new request panel type, add its class names here
 * and the shared layout rules apply automatically.
 */
const CONTAINERS = unsafeCSS(
  '.approval-requests, .bash-approval-requests, .retry-requests, .workflow-proposals, .plan-approval-requests',
);
const HEADERS = unsafeCSS(
  '.approval-requests__header, .bash-approval-requests__header, .retry-requests__header, .workflow-proposals__header, .plan-approval-requests__header',
);
const LISTS = unsafeCSS(
  '.approval-requests__list, .bash-approval-requests__list, .retry-requests__list, .workflow-proposals__list, .plan-approval-requests__list',
);
const ITEMS = unsafeCSS(
  '.approval-request, .bash-approval-request, .retry-request, .workflow-proposal, .plan-approval-request',
);
const DETAILS = unsafeCSS(
  '.approval-request__details, .bash-approval-request__details, .retry-request__details, .workflow-proposal__details, .plan-approval-request__details',
);
const ACTIONS = unsafeCSS(
  '.approval-request__actions, .bash-approval-request__actions, .retry-request__actions, .workflow-proposal__actions, .plan-approval-request__actions',
);

export const requestPanelStyles: CSSResult = css`
  /* ================================================================
   * Shared request panel layout (all panel types)
   * ================================================================ */

  :is(${CONTAINERS}) {
    margin: var(--spacing-large) 0;
    padding: var(--spacing-large);
    border-radius: var(--border-radius-large);
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.12));
    display: flex;
    flex-direction: column;
    gap: var(--spacing-large);
  }

  :is(${HEADERS}) {
    display: flex;
    align-items: center;
    gap: var(--spacing-medium);
    font-weight: var(--font-weight-semibold);
    color: var(--vscode-editor-foreground);
  }

  :is(${LISTS}) {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-large);
  }

  :is(${ITEMS}) {
    display: flex;
    flex-direction: column;
    border-radius: var(--border-radius);
    border: var(--border-thin) solid var(--vscode-editorHoverWidget-border);
    background: var(--vscode-editorHoverWidget-background);
    padding: var(--spacing-large);
    gap: var(--spacing-medium);
    position: relative;
  }

  :is(${DETAILS}) {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-small);
  }

  /* Scroll constraint for panels with potentially long content.
     Excluded: workflow-proposal__details (has an absolutely-positioned
     dropdown that would be clipped by overflow-y: auto). */
  .approval-request__details,
  .bash-approval-request__details,
  .retry-request__details,
  .plan-approval-request__details {
    max-height: 50vh;
    overflow-y: auto;
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

  :is(${ACTIONS}) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-small);
  }

  :is(${ACTIONS})::part(container) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-small);
  }

  :is(${ACTIONS}) vscode-toolbar-button {
    min-width: auto;
  }

  :is(${ACTIONS}) vscode-toolbar-button::part(control) {
    justify-content: flex-start;
    gap: var(--spacing-small);
  }

  /* Shared container chrome — approval, bash, retry, and plan use the same border/bg */
  .approval-requests,
  .bash-approval-requests,
  .retry-requests,
  .plan-approval-requests {
    border: var(--border-thin) solid var(--vscode-input-border);
    background: var(--vscode-editor-background);
  }

  /* Shared action button width — approval and bash use the same flex-basis */
  .approval-request__actions vscode-toolbar-button,
  .bash-approval-request__actions vscode-toolbar-button {
    flex: 1 1 12rem;
  }

  /* ================================================================
   * Approval requests (tool edits)
   * ================================================================ */

  .approval-requests__header .codicon {
    color: var(--vscode-editor-foreground);
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
    opacity: var(--opacity-normal);
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
    border-left: var(--border-thin) solid
      var(--vscode-button-separator, var(--vscode-input-border));
  }

  .approval-request__actions .diff-dropdown .diff-dropdown-menu {
    position: absolute;
    top: calc(100% + var(--spacing-tiny));
    left: 0;
    z-index: 100;
    min-width: 150px;
    display: block;
  }

  .approval-request__actions .diff-dropdown .diff-dropdown-menu:not([show]) {
    display: none;
  }

  .approval-request__actions
    .diff-dropdown-trigger[aria-expanded='true']
    .codicon-chevron-down {
    transform: rotate(180deg);
  }

  /* ================================================================
   * Bash approval requests
   * ================================================================ */

  .bash-approval-requests__header .codicon {
    color: var(--vscode-terminal-ansiYellow);
  }

  .bash-approval-request__command {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-sm);
  }

  .bash-approval-request__command .code-block {
    border-left: var(--border-thick) solid var(--vscode-terminal-ansiYellow);
  }

  .bash-approval-request__command .code-block pre {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ================================================================
   * Retry requests
   * ================================================================ */

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
    font-weight: var(--font-weight-medium);
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

  /* Note: .toggle-icon rotation handled by commonViewStyles */

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
    width: var(--border-thick);
    background: var(--vscode-editorWarning-foreground, #ff8c00);
    border-radius: var(--border-radius-small) 0 0 var(--border-radius-small);
  }

  /* ================================================================
   * Workflow proposals
   * ================================================================ */

  .workflow-proposals {
    border: var(--border-thin) solid var(--vscode-inputValidation-infoBorder);
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
    font-weight: var(--font-weight-semibold);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: var(--spacing-tiny) var(--border-radius-large);
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
    font-weight: var(--font-weight-semibold);
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

  .workflow-proposal__model-select {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
    margin-left: auto;
  }

  .workflow-proposal__model-select .codicon {
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .proposal-model-dropdown {
    min-width: 8rem;
    max-width: 12rem;
  }

  .workflow-proposal__instruction {
    font-size: var(--font-size-sm);
    color: var(--vscode-editor-foreground);
    word-break: break-word;
    white-space: pre-wrap;
    max-height: 12em;
    overflow-y: auto;
    line-height: var(--line-height-normal);
    padding: var(--spacing-small) 0;
    border-bottom: var(--border-thin) solid var(--vscode-editorWidget-border);
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
    line-height: var(--line-height-normal);
  }

  .workflow-proposal__file-label {
    font-weight: var(--font-weight-semibold);
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

  /* ================================================================
   * Plan approval requests
   * ================================================================ */

  .plan-approval-requests__header .codicon {
    color: var(--vscode-textLink-foreground);
  }

  .plan-approval-request__summary {
    font-weight: var(--font-weight-semibold);
    color: var(--vscode-editor-foreground);
  }

  .plan-approval-request__steps {
    margin: var(--spacing-small) 0;
    padding-left: var(--spacing-xlarge);
  }

  .plan-approval-request__steps li {
    margin-bottom: var(--spacing-small);
  }

  .plan-approval-request__step-desc {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .plan-approval-request__step-files {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    margin-top: var(--spacing-tiny);
  }

  .plan-approval-request__file {
    color: var(--vscode-textLink-foreground);
  }

  .plan-approval-request__actions vscode-toolbar-button {
    flex: 1 1 12rem;
  }

  /* ================================================================
   * Rejection feedback (shared across panels with feedback support)
   * ================================================================ */

  .approval-request__feedback,
  .bash-approval-request__feedback,
  .workflow-proposal__feedback,
  .plan-approval-request__feedback {
    margin-top: var(--spacing-small);
  }

  .approval-request__feedback-input,
  .bash-approval-request__feedback-input,
  .workflow-proposal__feedback-input,
  .plan-approval-request__feedback-input {
    width: 100%;
  }

  .approval-request--feedback-active
    .approval-request__actions
    vscode-toolbar-button[data-action='reject']::part(control),
  .bash-approval-request--feedback-active
    .bash-approval-request__actions
    vscode-toolbar-button[data-action='reject']::part(control),
  .workflow-proposal--feedback-active
    .workflow-proposal__actions
    vscode-toolbar-button[data-action='reject']::part(control),
  .plan-approval-request--feedback-active
    .plan-approval-request__actions
    vscode-toolbar-button[data-action='reject']::part(control) {
    color: var(--vscode-inputValidation-warningBorder);
  }
`;

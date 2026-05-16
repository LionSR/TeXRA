import { css, unsafeCSS, type CSSResult } from 'lit';

/**
 * Shared selector groups for :is() consolidation.
 * To add a new request panel type, add its class names to these two arrays
 * and the shared layout rules apply automatically.
 */

/** Container class names (plural, used as the outer wrapper). */
const CONTAINER_NAMES = [
  'approval-requests',
  'bash-approval-requests',
  'retry-requests',
  'workflow-proposals',
  'plan-approval-requests',
  'external-inquiry-requests',
  'user-question-requests',
] as const;

/** Item class names (singular, used for individual cards and BEM children). */
const ITEM_NAMES = [
  'approval-request',
  'bash-approval-request',
  'retry-request',
  'workflow-proposal',
  'plan-approval-request',
  'external-inquiry-request',
  'user-question-request',
] as const;

/** Build a :is()-ready selector group from class names with an optional BEM suffix. */
function selectorGroup(
  names: readonly string[],
  suffix = '',
): ReturnType<typeof unsafeCSS> {
  return unsafeCSS(names.map((n) => `.${n}${suffix}`).join(', '));
}

const CONTAINERS = selectorGroup(CONTAINER_NAMES);
const HEADERS = selectorGroup(CONTAINER_NAMES, '__header');
const LISTS = selectorGroup(CONTAINER_NAMES, '__list');
const ITEMS = selectorGroup(ITEM_NAMES);
const DETAILS = selectorGroup(ITEM_NAMES, '__details');
const ACTIONS = selectorGroup(ITEM_NAMES, '__actions');
const FEEDBACKS = selectorGroup(ITEM_NAMES, '__feedback');
const FEEDBACK_INPUTS = selectorGroup(ITEM_NAMES, '__feedback-input');
const FEEDBACK_ACTIVE = selectorGroup(ITEM_NAMES, '--feedback-active');
const BADGES = unsafeCSS(
  '.workflow-proposal__category-badge, .external-inquiry-request__mode-badge',
);
const SCROLLABLE_DETAILS = selectorGroup(
  ITEM_NAMES.filter((n) => n !== 'workflow-proposal'),
  '__details',
);

const sp = {
  tiny: unsafeCSS('var(--wa-space-3xs)'),
  small: unsafeCSS('var(--wa-space-2xs)'),
  medium: unsafeCSS('var(--wa-space-xs)'),
  large: unsafeCSS('var(--wa-space-s)'),
  xlarge: unsafeCSS('var(--wa-space-l)'),
} as const;

export const requestPanelStyles: CSSResult = css`
  /* ================================================================
   * Shared request panel layout (all panel types)
   * ================================================================ */

  :is(${CONTAINERS}) {
    margin: ${sp.medium} 0;
    padding: ${sp.medium};
    border: var(--border-thin) solid var(--wa-form-control-border-color);
    border-radius: var(--border-radius-large);
    background: var(--wa-color-surface-default);
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  :is(${HEADERS}) {
    display: flex;
    align-items: center;
    gap: ${sp.medium};
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  :is(${LISTS}) {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  :is(${ITEMS}) {
    display: flex;
    flex-direction: column;
    border-radius: var(--border-radius);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    background: var(--wa-color-surface-raised);
    padding: ${sp.medium};
    gap: ${sp.medium};
    position: relative;
  }

  :is(${DETAILS}) {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  /* Scroll constraint for panels with potentially long content.
     Excluded: workflow-proposal__details (has an absolutely-positioned
     dropdown that would be clipped by overflow-y: auto). */
  :is(${SCROLLABLE_DETAILS}) {
    max-height: min(34vh, 26rem);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .approval-request__meta,
  .retry-request__meta {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    gap: ${sp.small};
    flex-wrap: wrap;
  }

  :is(${ACTIONS}) {
    display: flex;
    flex-wrap: wrap;
    gap: ${sp.small};
  }

  :is(${ACTIONS})::part(container) {
    display: flex;
    flex-wrap: wrap;
    gap: ${sp.small};
  }

  :is(${ACTIONS}) vscode-toolbar-button {
    min-width: auto;
  }

  :is(${ACTIONS}) vscode-toolbar-button::part(control) {
    justify-content: flex-start;
    gap: ${sp.small};
  }

  /* Shared action button colors */
  :is(${ACTIONS}) vscode-toolbar-button[data-action='approve']::part(control),
  :is(${ACTIONS}) vscode-toolbar-button[data-action='submit']::part(control) {
    color: var(--wa-color-success-fill-loud);
  }

  :is(${ACTIONS}) vscode-toolbar-button[data-action='setup']::part(control) {
    color: var(--wa-color-text-link);
  }

  :is(${FEEDBACK_ACTIVE})
    :is(${ACTIONS})
    vscode-toolbar-button[data-action='reject']::part(control) {
    color: var(--wa-color-warning-border-quiet);
  }

  /* Shared badge base */
  :is(${BADGES}) {
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: ${sp.tiny} var(--border-radius-large);
    border-radius: var(--border-radius);
    white-space: nowrap;
  }

  /* Type-specific item accent */
  .approval-request {
    border-left: var(--border-medium) solid var(--wa-color-text-normal);
  }
  .bash-approval-request {
    border-left: var(--border-medium) solid var(--wa-color-terminal-ansi-yellow);
  }
  .retry-request {
    border-left: var(--border-medium) solid var(--color-warning);
  }
  .workflow-proposal {
    border-left: var(--border-medium) solid var(--wa-color-text-link);
  }
  .plan-approval-request {
    border-left: var(--border-medium) solid var(--wa-color-text-link);
  }
  .external-inquiry-request {
    border-left: var(--border-medium) solid var(--wa-color-focus);
  }
  .user-question-request {
    border-left: var(--border-medium) solid var(--wa-color-focus);
  }

  /* Shared action button width — approval and bash use the same flex-basis */
  .approval-request__actions vscode-toolbar-button,
  .bash-approval-request__actions vscode-toolbar-button {
    flex: 1 1 12rem;
  }

  /* ================================================================
   * Approval requests (tool edits)
   * ================================================================ */

  .approval-requests__header wa-icon {
    color: var(--wa-color-text-normal);
  }

  .approval-request__path {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    color: var(--color-text-link);
    word-break: break-word;
  }

  .approval-request__diff {
    display: inline-flex;
    align-items: baseline;
    gap: ${sp.small};
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
    flex: 0 1 auto;
    max-width: 100%;
  }

  .approval-request__actions .diff-dropdown .diff-main-button {
    flex: 0 1 auto;
    min-width: 0;
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
      var(--wa-color-button-separator, var(--wa-form-control-border-color));
  }

  /* wa-dropdown handles its own popup positioning, but we still want
     the trigger button to lay out alongside the main diff button. */
  .approval-request__actions .diff-dropdown .diff-dropdown-menu {
    flex: 0 0 auto;
    display: inline-flex;
  }

  .approval-request__actions
    .diff-dropdown
    wa-dropdown[open]
    .diff-dropdown-trigger
    wa-icon {
    transform: rotate(180deg);
  }

  /* ================================================================
   * Bash approval requests
   * ================================================================ */

  .bash-approval-requests__header wa-icon {
    color: var(--wa-color-terminal-ansi-yellow);
  }

  .bash-approval-request__command {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
  }

  .bash-approval-request__command .code-block {
    border-left: var(--border-medium) solid var(--wa-color-terminal-ansi-yellow);
  }

  .bash-approval-request__command .code-block pre {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ================================================================
   * Retry requests
   * ================================================================ */

  .retry-requests__header wa-icon {
    color: var(--color-warning);
  }

  .retry-request__actions vscode-toolbar-button {
    flex: 1 1 8rem;
  }

  .retry-request__operation {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
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
    margin-top: ${sp.tiny};
    font-size: var(--font-size-xs);
  }

  .retry-request__error-details::part(header) {
    min-height: 28px;
    padding: ${sp.small} ${sp.large};
    color: var(--wa-color-text-quiet);
  }

  .retry-request__error-details::part(content) {
    padding: 0 ${sp.large} ${sp.large};
  }

  .retry-request__error-summary {
    cursor: pointer;
    color: var(--wa-color-text-quiet);
    display: flex;
    align-items: center;
    gap: ${sp.tiny};
    user-select: none;
  }

  .retry-request__error-summary:hover {
    color: var(--wa-color-text-normal);
  }

  /* Note: .toggle-icon rotation handled by commonViewStyles */

  .retry-request__error-body {
    margin-top: ${sp.tiny};
    padding: ${sp.small};
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.1));
    border-radius: var(--border-radius-small);
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
  }

  .retry-request--relay .retry-request__operation {
    color: var(--wa-color-warning-on-quiet, #ff8c00);
  }

  /* ================================================================
   * Workflow proposals
   * ================================================================ */

  .workflow-proposals__header wa-icon {
    color: var(--wa-color-text-link);
  }

  .workflow-proposal__actions vscode-toolbar-button {
    flex: 1 1 6rem;
  }

  .workflow-proposal__header-row {
    display: flex;
    align-items: baseline;
    gap: ${sp.medium};
    flex-wrap: wrap;
  }

  .workflow-proposal__category-badge--workflow {
    background: var(--wa-color-neutral-fill-quiet);
    color: var(--wa-color-neutral-on-quiet);
  }

  .workflow-proposal__category-badge--tool-use {
    background: var(--wa-color-text-link);
    color: var(--wa-color-surface-default);
  }

  .workflow-proposal__agent {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-link);
  }

  .workflow-proposal__model {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .workflow-proposal__model::before {
    content: '\u2022';
    margin-right: ${sp.small};
  }

  .workflow-proposal__agent-select,
  .workflow-proposal__model-select {
    display: flex;
    align-items: center;
    gap: ${sp.small};
  }

  .workflow-proposal__agent-select wa-icon,
  .workflow-proposal__model-select wa-icon {
    color: var(--wa-color-text-quiet);
    flex-shrink: 0;
  }

  /* Model dropdown floats to the right edge of the header row. */
  .workflow-proposal__model-select {
    margin-left: auto;
  }

  .proposal-model-dropdown {
    min-width: 6rem;
    max-width: 9rem;
  }

  .proposal-agent-dropdown {
    min-width: 5rem;
    max-width: 8rem;
  }

  .workflow-proposal__instruction {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    word-break: break-word;
    max-height: 12em;
    overflow-y: auto;
    line-height: var(--line-height-normal);
    padding: ${sp.small} 0;
    border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .workflow-proposal__instruction pre {
    white-space: pre-wrap;
  }

  .workflow-proposal__extract-flags {
    display: flex;
    gap: ${sp.small};
    flex-wrap: wrap;
    margin-top: ${sp.small};
  }

  .workflow-proposal__extract-flag {
    display: inline-flex;
    align-items: center;
    gap: ${sp.tiny};
    text-transform: none;
    letter-spacing: normal;
  }

  .workflow-proposal__files {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    margin-top: ${sp.small};
  }

  .workflow-proposal__files > div {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-normal);
  }

  .workflow-proposal__file-label {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-secondary);
  }

  .workflow-proposal__file-name {
    font-family: var(--wa-font-family-mono);
    color: var(--wa-color-text-link);
    cursor: pointer;
  }

  .workflow-proposal__file-name:hover {
    text-decoration: underline;
    color: var(--wa-color-text-link-active, var(--wa-color-text-link));
  }

  .workflow-proposal__file-name--readonly {
    color: var(--color-text-secondary);
    cursor: default;
  }

  .workflow-proposal__file-name--readonly:hover {
    text-decoration: none;
    color: var(--color-text-secondary);
  }

  .workflow-proposal__file-name--wrap {
    word-break: break-word;
  }

  .workflow-proposal__input-files .workflow-proposal__file-label {
    color: var(--wa-color-text-normal);
  }

  .workflow-proposal__output-files .workflow-proposal__file-label {
    color: var(--wa-color-text-link);
  }

  /* ================================================================
   * Plan approval requests
   * ================================================================ */

  .plan-approval-requests__header wa-icon {
    color: var(--wa-color-text-link);
  }

  .plan-approval-request__summary {
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .plan-approval-request__steps {
    margin: ${sp.small} 0;
    padding-left: ${sp.xlarge};
  }

  .plan-approval-request__steps li {
    margin-bottom: ${sp.small};
  }

  .plan-approval-request__step-desc {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }

  .plan-approval-request__step-files {
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    margin-top: ${sp.tiny};
  }

  .plan-approval-request__file {
    color: var(--wa-color-text-link);
  }

  .plan-approval-request__actions vscode-toolbar-button {
    flex: 1 1 12rem;
  }

  /* ================================================================
   * Rejection feedback (shared across panels with feedback support)
   * ================================================================ */

  :is(${FEEDBACKS}) {
    margin-top: ${sp.small};
  }

  :is(${FEEDBACK_INPUTS}) {
    width: 100%;
  }

  /* ================================================================
   * External inquiry requests
   * ================================================================ */

  .external-inquiry-requests__header wa-icon {
    color: var(--wa-color-focus);
  }

  /* Carousel navigation for multiple external inquiries */
  .external-inquiry-requests__nav {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    margin-left: auto;
  }

  .external-inquiry-requests__counter {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    font-variant-numeric: tabular-nums;
    min-width: 3ch;
    text-align: center;
  }

  .external-inquiry-request__mode-badge {
    background: var(--wa-color-neutral-fill-quiet);
    color: var(--wa-color-neutral-on-quiet);
  }

  .external-inquiry-request__context {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    padding: ${sp.small} ${sp.medium};
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.1));
    border-radius: var(--border-radius-small);
    line-height: var(--line-height-normal);
  }

  .external-inquiry-request__question {
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.05));
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius);
    padding: ${sp.medium};
    position: relative;
  }

  .external-inquiry-request__question-text {
    font-size: var(--font-size);
    line-height: var(--line-height-relaxed, 1.6);
    color: var(--wa-color-text-normal);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: min(22vh, 14rem);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .external-inquiry-request__question-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: ${sp.small};
    padding-top: ${sp.small};
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .external-inquiry-request__transcript {
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.05));
  }

  .external-inquiry-request__transcript-summary {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    padding: ${sp.small} ${sp.medium};
    cursor: pointer;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
  }

  .external-inquiry-request__transcript-turns {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
    max-height: min(28vh, 18rem);
    overflow-y: auto;
    padding: ${sp.medium};
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
    scrollbar-gutter: stable;
  }

  .external-inquiry-request__transcript-turn {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .external-inquiry-request__transcript-turn
    + .external-inquiry-request__transcript-turn {
    padding-top: ${sp.medium};
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .external-inquiry-request__transcript-turn-header,
  .external-inquiry-request__transcript-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-quiet);
  }

  .external-inquiry-request__transcript-context {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }

  .external-inquiry-request__transcript-text {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .external-inquiry-request__transcript-links {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
  }

  .external-inquiry-request__search-hint {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    font-size: var(--font-size-sm);
    color: var(--wa-color-brand-on-quiet, var(--wa-color-focus));
    padding: ${sp.small} 0;
  }

  .external-inquiry-request__attach-files {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .external-inquiry-request__attach-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-quiet);
    display: flex;
    align-items: center;
    gap: ${sp.small};
  }

  .external-inquiry-request__file-list {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
    padding: ${sp.small};
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.1));
    border-radius: var(--border-radius-small);
  }

  .external-inquiry-request__file-item {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    font-size: var(--font-size-sm);
    font-family: var(--wa-font-family-mono);
    color: var(--wa-color-text-link);
  }

  .external-inquiry-request__answer-area {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .external-inquiry-request__session-links {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .external-inquiry-request__session-links-known,
  .external-inquiry-request__session-links-input-group {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .external-inquiry-request__session-links-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .external-inquiry-request__session-links-list {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
    padding: ${sp.small};
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.1));
    border-radius: var(--border-radius-small);
  }

  .external-inquiry-request__session-link-item {
    display: block;
    font-size: var(--font-size-sm);
    font-family: var(--wa-font-family-mono);
    color: var(--wa-color-text-link);
    text-decoration: none;
    word-break: break-word;
  }

  a.external-inquiry-request__session-link-item:hover {
    text-decoration: underline;
  }

  .external-inquiry-request__session-links-input {
    width: 100%;
    min-height: 2.75rem;
    max-height: min(12vh, 5rem);
    resize: vertical;
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    padding: ${sp.small} ${sp.medium};
    background: var(--wa-form-control-background-color);
    color: var(--wa-form-control-text-color);
    border: var(--border-thin) solid var(--wa-form-control-border-color);
    border-radius: var(--border-radius);
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .external-inquiry-request__session-links-input:focus {
    border-color: var(--wa-color-focus);
  }

  .external-inquiry-request__session-links-input::placeholder {
    color: var(--wa-color-text-placeholder);
  }

  .external-inquiry-request__session-links-hint {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }

  .external-inquiry-request__chat-links {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }

  .external-inquiry-request__chat-links a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }

  .external-inquiry-request__chat-links a:hover {
    text-decoration: underline;
  }

  .external-inquiry-request__answer-label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .external-inquiry-request__answer-input {
    width: 100%;
    min-height: 96px;
    max-height: min(24vh, 12rem);
    resize: vertical;
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size);
    line-height: var(--line-height-normal);
    padding: ${sp.medium};
    background: var(--wa-form-control-background-color);
    color: var(--wa-form-control-text-color);
    border: var(--border-thin) solid var(--wa-form-control-border-color);
    border-radius: var(--border-radius);
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .external-inquiry-request__answer-input:focus {
    border-color: var(--wa-color-focus);
  }

  .external-inquiry-request__answer-input::placeholder {
    color: var(--wa-color-text-placeholder);
  }

  .external-inquiry-request__answer-hint {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }

  @media (max-height: 900px) {
    :is(${SCROLLABLE_DETAILS}) {
      max-height: min(28vh, 20rem);
    }

    .external-inquiry-request__question-text {
      max-height: min(18vh, 10rem);
    }

    .external-inquiry-request__answer-input {
      min-height: 80px;
      max-height: min(20vh, 10rem);
    }

    .external-inquiry-request__session-links-input {
      min-height: 2.5rem;
      max-height: min(10vh, 4.5rem);
    }
  }

  .external-inquiry-request__actions vscode-toolbar-button {
    flex: 1 1 8rem;
  }

  /* ================================================================
   * User question requests
   * ================================================================ */

  .user-question-requests__header wa-icon {
    color: var(--wa-color-focus);
  }

  .user-question-request__context {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    padding: ${sp.small} ${sp.medium};
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.1));
    border-radius: var(--border-radius-small);
    line-height: var(--line-height-normal);
  }

  .user-question-request__questions {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
  }

  .user-question-request__question {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
    padding: ${sp.medium};
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-lowered, rgba(0, 0, 0, 0.05));
  }

  .user-question-request__heading {
    display: flex;
    align-items: baseline;
    gap: ${sp.small};
    color: var(--wa-color-text-normal);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-normal);
  }

  .user-question-request__header {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    flex: 0 0 auto;
  }

  .user-question-request__options {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  .user-question-request__option {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: ${sp.small};
    align-items: start;
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    color: var(--wa-color-text-normal);
    cursor: pointer;
  }

  .user-question-request__option input {
    margin-top: 0.2rem;
  }

  .user-question-request__option span {
    display: flex;
    flex-direction: column;
    gap: ${sp.tiny};
  }

  .user-question-request__option small {
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-xs);
  }

  .user-question-request__free-text {
    width: 100%;
  }

  .user-question-request__actions vscode-toolbar-button {
    flex: 1 1 8rem;
  }
`;

import { css, type CSSResult } from 'lit';

export const permissionCardStyles: CSSResult = css`
  :host {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    background: color-mix(
      in srgb,
      var(--texra-editor-background) 70%,
      transparent
    );
  }

  :host([hidden]) {
    display: none;
  }

  .permission-card {
    background: var(--texra-editor-background);
    border: var(--border-thin) solid var(--texra-panel-border);
    border-radius: var(--border-radius-large);
    padding: var(--wa-space-l);
    max-width: 600px;
    width: min(92vw, 600px);
    max-height: min(80vh, 44rem);
    overflow: hidden;
    box-shadow: 0 2px 8px var(--texra-widget-shadow, rgba(0, 0, 0, 0.24));
  }

  .permission-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    font-weight: var(--font-weight-semibold);
    margin-bottom: var(--wa-space-xs);
  }

  .permission-body {
    font-size: var(--font-size);
    line-height: var(--line-height-relaxed);
    max-height: min(38vh, 24rem);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .code-block {
    display: block;
    padding: var(--wa-space-xs);
    background: var(--texra-textCodeBlock-background);
    border-radius: var(--border-radius);
    color: var(--texra-terminal-foreground);
    font-family: var(--texra-editor-font-family);
    font-size: var(--font-size);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .permission-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-xs);
    margin-top: var(--wa-space-l);
    justify-content: flex-end;
  }

  .secondary-actions,
  .primary-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-xs);
  }

  .primary-actions {
    margin-left: auto;
  }

  .file-path {
    font-family: var(--texra-editor-font-family);
    font-size: var(--font-size-sm);
    color: var(--texra-textLink-foreground);
    word-break: break-word;
  }

  .diff-info {
    display: inline-flex;
    align-items: baseline;
    gap: var(--wa-space-2xs);
    font-size: var(--font-size-sm);
    font-family: var(--texra-editor-font-family);
  }

  .diff-added {
    color: var(--texra-gitDecoration-addedResourceForeground, #89d185);
    font-weight: var(--font-weight-medium);
  }

  .diff-removed {
    color: var(--texra-gitDecoration-deletedResourceForeground, #f48771);
    font-weight: var(--font-weight-medium);
  }

  .meta-text {
    color: var(--texra-descriptionForeground);
    margin-left: var(--wa-space-2xs);
  }

  .extract-flags {
    display: flex;
    gap: var(--wa-space-2xs);
    flex-wrap: wrap;
  }

  .extract-flag {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    border-radius: var(--border-radius);
    background: var(--texra-badge-background);
    color: var(--texra-badge-foreground);
  }

  .file-list {
    margin: var(--wa-space-2xs) 0;
  }

  .file-list-label {
    color: var(--texra-descriptionForeground);
    margin-right: var(--wa-space-2xs);
  }

  .file-link {
    color: var(--texra-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .file-link:hover {
    text-decoration: underline;
  }

  .file-link:focus-visible {
    outline: var(--border-thin) solid var(--texra-focusBorder);
    outline-offset: 1px;
    border-radius: var(--border-radius-small);
  }

  .plan-steps-list {
    margin: var(--wa-space-2xs) 0;
    padding-left: var(--wa-space-l);
  }

  .plan-steps-list li {
    margin-bottom: var(--wa-space-2xs);
  }

  .feedback-section {
    margin-top: var(--wa-space-s);
  }

  .feedback-label {
    display: block;
    margin-bottom: var(--wa-space-2xs);
    font-size: var(--font-size-sm);
    color: var(--texra-descriptionForeground);
  }

  .feedback-input {
    width: 100%;
    min-height: 60px;
    padding: var(--wa-space-xs);
    border: var(--border-thin) solid var(--texra-input-border);
    background: var(--texra-input-background);
    color: var(--texra-input-foreground);
    border-radius: var(--border-radius);
    font-family: inherit;
    font-size: var(--font-size);
    resize: vertical;
    box-sizing: border-box;
  }

  .feedback-input:focus-visible {
    outline: var(--border-thin) solid var(--texra-focusBorder);
  }
`;

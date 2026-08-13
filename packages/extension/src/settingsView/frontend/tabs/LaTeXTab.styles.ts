/** Component-scoped styles for {@link LaTeXTab}. */

import { css, type CSSResult } from 'lit';

export const latexTabStyles: CSSResult = css`
  :host {
    display: block;
  }

  .latex-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--wa-space-s);
  }

  .dependency-card {
    padding-block: var(--wa-space-s);
    border-bottom: var(--border-thin) solid var(--border-hairline);
  }

  .dependency-row {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-xs);
  }

  .dependency-icon,
  .setting-status-icon {
    flex-shrink: 0;
    font-size: var(--font-size-lg);
  }

  .dependency-icon.installed,
  .setting-status-icon.is-set {
    color: var(--color-status-ok);
  }

  .dependency-icon.missing {
    color: var(--color-status-error);
  }

  /* Using-default state for non-boolean settings (number/enum). Not a
     problem — just hasn't been overridden. Render neutral, not red. */
  .setting-status-icon.is-default {
    color: var(--color-text-secondary);
  }

  .dependency-info {
    flex: 1;
    min-width: 0;
  }

  .dependency-name {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
  }

  .dependency-description {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    margin-top: var(--wa-space-3xs);
  }

  .dependency-guide-details {
    margin-top: var(--wa-space-2xs);
  }

  .dependency-guide {
    padding: var(--wa-space-xs);
    background: var(--wa-color-surface-lowered);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    line-height: var(--line-height-relaxed);
    white-space: pre-wrap;
  }

  .dependency-path {
    margin-top: var(--wa-space-3xs);
    font-family: var(--wa-font-family-mono, monospace), monospace;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .dependency-install-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    margin-top: var(--wa-space-2xs);
  }

  .install-command-text {
    flex: 1;
    min-width: 0;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    background: var(--wa-color-surface-lowered);
    border-radius: var(--border-radius-small);
    font-family: var(--wa-font-family-mono, monospace), monospace;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The shared settings banner owns the callout; this view only lets the
     install command consume the remaining action-row width. */
  .prerequisite-hint {
    margin-bottom: var(--wa-space-xs);
  }

  .prerequisite-hint .settings-banner-actions {
    flex-wrap: nowrap;
  }

  .setting-number-input {
    width: 140px;
  }

  .setting-enum-select {
    min-width: 180px;
  }

  .replacement-groups-row,
  .replacement-map-row {
    align-items: flex-start;
  }

  .replacement-category-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: var(--wa-space-xs);
    margin-top: var(--wa-space-s);
  }

  .replacement-map-row wa-textarea {
    width: min(760px, 100%);
    margin-top: var(--wa-space-s);
    font-family: var(--wa-font-family-mono, monospace), monospace;
  }

  .replacement-json-error {
    display: block;
    margin-top: var(--wa-space-2xs);
    color: var(--color-status-error);
    font-size: var(--font-size-sm);
  }

  .setting-config-key {
    font-family: var(--wa-font-family-mono, monospace), monospace;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--wa-space-2xs);
  }

  .setting-value {
    font-family: var(--wa-font-family-mono, monospace), monospace;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-link);
  }

  wa-tag.setting-badge {
    flex-shrink: 0;
  }
`;

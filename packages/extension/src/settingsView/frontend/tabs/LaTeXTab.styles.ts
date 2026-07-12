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

  .latex-description {
    margin-bottom: var(--wa-space-s);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
  }

  /* Shared card chrome for dependency + setting rows */
  .dependency-card,
  .setting-card {
    padding: var(--wa-space-xs);
    margin-bottom: var(--wa-space-xs);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
    background: var(--wa-color-surface-default);
  }

  .setting-card {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-xs);
  }

  .dependency-row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
  }

  .dependency-icon,
  .setting-status-icon {
    flex-shrink: 0;
    font-size: var(--font-size-lg);
  }

  .setting-status-icon {
    margin-top: var(--wa-space-3xs);
  }

  .dependency-icon.installed,
  .setting-status-icon.is-set {
    color: var(--color-status-ok);
  }

  .dependency-icon.missing,
  .setting-status-icon.not-set {
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

  /* Prerequisite hint uses wa-callout; only layout for actions row + the
     inline command text live here. */
  wa-callout.prerequisite-hint {
    margin-bottom: var(--wa-space-xs);
    /* wa-callout ignores --padding; set the real property (its :host hardcodes 1em). */
    padding: var(--wa-space-xs);
  }

  .hint-title {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
    margin-bottom: var(--wa-space-3xs);
  }

  .hint-description {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    line-height: var(--line-height-normal);
  }

  .hint-actions {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    margin-top: var(--wa-space-2xs);
  }

  /* .section-header chrome lives in commonViewStyles; this view spaces the
     subsequent sections from the cards above them. */
  .section-header.spaced {
    margin-top: var(--wa-space-s);
  }

  /* Number / enum controls inside a setting card sit below the description. */
  .setting-number-input {
    margin-top: var(--wa-space-2xs);
    width: 140px;
  }

  .setting-enum-select {
    margin-top: var(--wa-space-2xs);
  }

  .setting-info {
    flex: 1;
    min-width: 0;
  }

  .setting-name {
    font-weight: var(--font-weight-medium);
    color: var(--wa-color-text-normal);
    margin-bottom: var(--wa-space-3xs);
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

  .setting-description {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    line-height: var(--line-height-normal);
    margin-top: var(--wa-space-2xs);
  }

  wa-tag.setting-badge {
    flex-shrink: 0;
  }
`;

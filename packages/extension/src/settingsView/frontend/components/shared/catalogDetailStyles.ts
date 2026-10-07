import { css, type CSSResult } from 'lit';

export const catalogDetailStyles: CSSResult = css`
  .catalog-toolbar-actions,
  .catalog-footer-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs);
  }
  .catalog-footer-actions {
    margin-block-start: var(--wa-space-xs);
  }
  .catalog-detail-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs);
    margin-block-end: var(--wa-space-xs);
  }
  .catalog-detail-name {
    flex-basis: 100%;
    overflow-wrap: anywhere;
    margin: 0 0 var(--wa-space-2xs);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-tight);
  }
  .catalog-detail-description {
    line-height: var(--line-height-normal);
    margin: 0 0 var(--wa-space-xs);
    overflow-wrap: anywhere;
  }
  .catalog-detail-meta {
    display: grid;
    gap: var(--wa-space-2xs);
    margin-block: var(--wa-space-s);
    font-size: var(--font-size-sm);
  }
  .catalog-detail-meta-label {
    font-weight: var(--font-weight-medium);
    color: var(--color-text-secondary);
  }
  .catalog-detail-meta-value {
    margin: 0 0 var(--wa-space-xs);
    min-width: 0;
  }
  .catalog-detail-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wa-space-2xs);
  }
  .catalog-tool-badge {
    font-family: var(--wa-font-family-mono);
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .catalog-detail-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    flex-wrap: wrap;
    margin-block: var(--wa-space-xs);
  }
  .catalog-footnote {
    padding-block-start: var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-secondary);
  }
  .catalog-detail-path {
    font-size: var(--font-size-xs);
    font-family: var(--wa-font-family-mono);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

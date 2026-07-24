/** Component-scoped styles for {@link ApiAccessSection}. */

import { css, type CSSResult } from 'lit';

export const apiAccessSectionStyles: CSSResult = css`
  /* Generic section heading, duplicated identically in ProviderKeyList.styles.ts
     and ModelSelectionList.styles.ts — each profile section renders its own
     bare <h2>, and the rule is too small to warrant a shared module. */
  h2 {
    color: var(--wa-color-text-normal);
    margin-top: var(--wa-space-l);
    margin-bottom: var(--wa-space-xs);
    font-size: var(--font-size-lg);
    border-bottom: var(--border-thin) solid var(--color-border);
    padding-bottom: var(--wa-space-2xs);
  }

  /* ============================================
   * API Access Options
   * ============================================ */

  .api-access-section {
    margin-top: var(--wa-space-l);
    margin-bottom: var(--wa-space-l);
  }

  /* wa-radio-group provides layout + keyboard navigation; the per-option card
     chrome (border, background, hover) is rendered on each <wa-radio>. */
  wa-radio-group.api-access-options {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
  }

  wa-radio.api-access-option {
    align-items: flex-start;
    padding: var(--wa-space-xs);
    background: var(--wa-form-control-background-color);
    border: var(--border-thin) solid var(--color-border);
    border-radius: var(--border-radius);
  }

  wa-radio.api-access-option:hover {
    border-color: var(--wa-color-focus);
  }

  wa-radio.api-access-option[checked] {
    border-color: var(--wa-color-focus);
    background: var(--wa-color-neutral-fill-quiet);
  }

  .api-access-support {
    display: flex;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }

  .api-access-support-icon {
    flex-shrink: 0;
    margin-top: var(--wa-space-3xs);
    color: var(--wa-color-chart-red, var(--wa-color-danger-on-quiet));
  }

  .api-access-support a {
    color: var(--wa-color-text-link);
    text-decoration: none;
  }

  .api-access-support a:hover {
    color: var(--wa-color-text-link-active);
    text-decoration: underline;
  }

  .option-content {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-2xs);
  }

  .option-title {
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .option-status {
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
  }

  .option-description {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
  }
`;

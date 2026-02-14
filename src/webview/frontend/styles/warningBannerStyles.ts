/**
 * Shared styles for warning-type banners (API key, agent config, dependency).
 *
 * Provides the common layout (flex row, warning colors, padding/margin)
 * and action button container used by all warning banners.
 */

import { css, type CSSResult } from 'lit';

export const warningBannerStyles: CSSResult = css`
  :host {
    display: block;
  }

  .warning-banner {
    border-radius: var(--border-radius);
    padding: var(--spacing-small) var(--spacing-medium);
    margin-bottom: var(--spacing-large);
    background-color: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground);
    border: var(--border-thin) solid var(--vscode-inputValidation-warningBorder);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }
`;

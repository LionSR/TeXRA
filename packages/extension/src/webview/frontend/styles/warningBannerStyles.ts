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
    background-color: var(--texra-inputValidation-warningBackground);
    color: var(--texra-inputValidation-warningForeground);
    border: var(--border-thin) solid var(--texra-inputValidation-warningBorder);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--spacing-tiny) var(--spacing-medium);
  }

  .warning-banner .hint {
    width: 100%;
    font-size: var(--font-size-sm);
    opacity: var(--opacity-normal);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-small);
  }
`;

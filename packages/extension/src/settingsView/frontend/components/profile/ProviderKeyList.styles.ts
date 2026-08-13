/** Component-scoped styles for {@link ProviderKeyList}. */

import { css, type CSSResult } from 'lit';

export const providerKeyListStyles: CSSResult = css`
  .provider-name {
    font-weight: var(--font-weight-medium);
    white-space: nowrap;
  }

  .provider-actions {
    white-space: nowrap;
  }

  .provider-settings {
    display: flex;
    flex-direction: column;
    gap: var(--wa-space-xs);
  }

  .provider-setting {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
  }

  .provider-setting label {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
    min-width: 120px;
  }

  .provider-setting wa-switch {
    font-size: var(--font-size-sm);
    min-width: 120px;
  }

  .provider-setting--block {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--wa-space-2xs);
  }

  .provider-setting-description,
  .provider-setting-warning {
    font-size: var(--font-size-sm);
    line-height: var(--line-height-normal);
    padding-inline-start: var(--wa-space-l);
  }

  .provider-setting-description {
    color: var(--color-text-secondary);
  }

  .provider-setting-warning {
    color: var(--wa-color-warning-on-quiet);
  }

  wa-button.provider-setting-link {
    margin-inline-start: var(--wa-space-2xs);
  }

  .endpoint-input {
    max-width: 400px;
  }

  @container settings (max-width: 520px) {
    .provider-setting {
      align-items: stretch;
      flex-direction: column;
    }
  }
`;

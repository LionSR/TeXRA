/**
 * Shared styles for informational notices shown in the main view.
 *
 * Covers both full-width info banners and the inline session hint so
 * dismissible user guidance uses one visual system and one layout model.
 */

// Third-party imports
import { css, type CSSResult } from 'lit';

export const infoNoticeStyles: CSSResult = css`
  :host {
    display: block;
  }

  .info-notice {
    border-radius: var(--border-radius);
  }

  .info-notice__main {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--spacing-small);
  }

  .info-notice__leading {
    display: flex;
    align-items: flex-start;
    flex: 0 0 auto;
  }

  .info-notice__content {
    flex: 1 1 auto;
    min-width: 0;
    line-height: var(--line-height-relaxed);
  }

  .info-notice__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--spacing-small);
    flex: 0 0 auto;
    margin-left: auto;
  }

  .info-notice__secondary {
    margin-top: var(--spacing-small);
  }

  .info-notice__dismiss-button {
    flex-shrink: 0;
    background: none;
    border: var(--border-thin) solid var(--vscode-inputValidation-infoBorder);
    color: inherit;
    cursor: pointer;
    padding: var(--spacing-tiny) var(--spacing-medium);
    border-radius: var(--border-radius);
    font-size: var(--font-size-sm);
  }

  .info-notice__dismiss-button:hover {
    background: color-mix(
      in srgb,
      var(--vscode-inputValidation-infoBorder) 15%,
      transparent
    );
  }

  .info-notice__dismiss-button:focus-visible {
    outline: var(--border-thin) solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .info-notice--banner {
    margin-bottom: var(--spacing-large);
    padding: var(--spacing-small) var(--spacing-medium);
    background-color: var(--vscode-inputValidation-infoBackground);
    color: var(--vscode-inputValidation-infoForeground);
    border: var(--border-thin) solid var(--vscode-inputValidation-infoBorder);
  }

  .info-notice--banner .info-notice__main {
    gap: var(--spacing-medium);
  }

  .info-notice--inline {
    margin-top: var(--spacing-small);
    padding: var(--spacing-tiny) var(--spacing-small);
    border-left: 2px solid var(--vscode-textLink-foreground);
    color: var(--vscode-descriptionForeground);
    font-size: var(--font-size-sm);
  }

  .info-notice--inline .info-notice__content {
    display: flex;
    gap: var(--spacing-small);
    align-items: baseline;
  }
`;

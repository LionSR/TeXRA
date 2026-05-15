/**
 * Main view styles for MainApp component.
 *
 * These styles apply to MainApp's Shadow DOM template content.
 * Shared component styles are in styles/fileSelectStyles.ts.
 */

// Third-party imports
import { css, type CSSResult } from 'lit';

export const mainViewStyles: CSSResult = css`
  :host {
    background-color: transparent;
    color: var(--text-color);
    font-weight: var(--font-weight);
    min-height: 100vh;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: 0 var(--wa-space-3xs) var(--wa-space-2xs);
    flex-shrink: 0;
  }

  .header-action {
    flex-shrink: 0;
  }

  .header-action::part(base) {
    min-height: var(--height-control, 24px);
  }

  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /*
   * Hairline separator between sections of the launcher. Kept subtle
   * (single-pixel surface-border line) so the primary instruction flow
   * stays the dominant visual element, with secondary regions like the
   * file-select group quietly demarcated below.
   */
  .section-separator {
    border-top: var(--border-thin) solid
      var(--wa-color-surface-border, var(--color-border));
    margin: 0 0 var(--wa-space-2xs);
  }

  /*
   * Files section sits BELOW the instruction-panel (textarea + toolbar).
   * Wrapped in a wa-details so the document slots collapse to a single
   * slim summary row by default, keeping the primary "what do you want to
   * do?" textarea front-and-center and unblocked.
   */
  wa-details.file-selection-details {
    margin-bottom: var(--wa-space-s);
    background: transparent;
  }

  wa-details.file-selection-details::part(base) {
    background: transparent;
    border: none;
    border-radius: 0;
  }

  wa-details.file-selection-details::part(header) {
    padding: var(--wa-space-3xs) var(--wa-space-2xs);
    min-height: 22px;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
  }

  wa-details.file-selection-details[open]::part(header) {
    color: var(--wa-color-text-normal);
  }

  wa-details.file-selection-details::part(content) {
    padding: var(--wa-space-2xs) 0 0;
  }

  wa-details.file-selection-details .file-selection-summary {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  wa-details.file-selection-details .file-selection-summary wa-icon {
    color: var(--wa-color-text-quiet);
  }

  .file-selection-group {
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    overflow: visible;
  }

  .file-selection-group--disabled {
    display: none;
  }
`;

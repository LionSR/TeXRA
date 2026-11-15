// Inline loading-state pattern shared between hosts. Counterpart to
// renderEmptyState, styled by the same sheet (placeholderStyles).

import { html, type TemplateResult } from 'lit';

import { waSpinner } from './spinner';

export function renderLoadingState(label: string): TemplateResult {
  // Stable role="status" region: the label announces when the loading state
  // appears, and aria-busy marks the region while content is being loaded.
  return html`
    <div class="loading-state" role="status" aria-busy="true">
      ${waSpinner()} ${label}
    </div>
  `;
}

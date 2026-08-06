// Inline loading-state pattern shared between hosts. Counterpart to
// renderEmptyState: consumers style via the .loading-state class hook
// (shared rule in commonViewStyles); the helper owns the structure.

import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { html, type TemplateResult } from 'lit';

export function renderLoadingState(label: string): TemplateResult {
  // Stable role="status" region: the label announces when the loading state
  // appears, and aria-busy marks the region while content is being loaded.
  return html`
    <div class="loading-state" role="status" aria-busy="true">
      <wa-spinner></wa-spinner>
      ${label}
    </div>
  `;
}

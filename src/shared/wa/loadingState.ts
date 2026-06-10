// Inline loading-state pattern shared between hosts. Counterpart to
// renderEmptyState: consumers style via the .loading-state class hook
// (shared rule in commonViewStyles); the helper owns the structure.

import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { html, type TemplateResult } from 'lit';

export function renderLoadingState(label: string): TemplateResult {
  return html`
    <div class="loading-state">
      <wa-spinner></wa-spinner>
      ${label}
    </div>
  `;
}

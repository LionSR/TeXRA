// The small pieces of chrome more than one pane draws.

// Third-party imports
import { html, type TemplateResult } from 'lit';

/** The dot on a tab or a tree row whose file has unsaved changes. */
export function unsavedDot(): TemplateResult {
  // prettier-ignore
  return html`<span class="status-dot unsaved-dot" role="img" aria-label="Unsaved changes"></span>`;
}

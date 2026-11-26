// The small pieces of chrome more than one pane draws.

// Third-party imports
import { html, render, type TemplateResult } from 'lit';

// Local imports - UI kit
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import type { IconName } from '@ui/wa/iconNames';

/** The footer under a file a pane shows: its path, then the one action the
 *  pane offers on it. */
export function pathFooter(
  path: string,
  action: {
    readonly text: string;
    readonly icon: IconName;
    readonly onClick: () => void;
  },
): HTMLElement {
  const footer = document.createElement('footer');
  footer.className = 'shell-editor-toolbar';
  render(
    // prettier-ignore
    html`<span class="shell-editor-path truncate" title=${path}>${path}</span>${renderLabeledActionButton({ ...action, kind: 'ghost', className: 'is-compact' })}`,
    footer,
  );
  return footer;
}

/** The dot on a tab or a tree row whose file has unsaved changes. */
export function unsavedDot(): TemplateResult {
  // prettier-ignore
  return html`<span class="status-dot unsaved-dot" role="img" aria-label="Unsaved changes"></span>`;
}

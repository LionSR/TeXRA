// The filter above the task list, in the drawer and in the wide editor tab's
// docked list alike: bound to `Surface.search`, which `<run-tabs>` filters
// by. `host`, the element that renders it, sends each edit to the root as a
// `surface-action`.

import { css, html, type TemplateResult } from 'lit';

import { SessionUiEvents } from '@ui/progress/uiEvents';
import { renderFilterField } from '@ui/wa/filterField';

export const taskFilterStyles = css`
  .task-filter {
    flex: 0 0 auto;
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--color-border);
  }
`;

export function renderTaskFilter(
  host: HTMLElement,
  search: string,
): TemplateResult {
  return html`<div class="task-filter">
    ${renderFilterField({
      label: 'Filter tasks',
      value: search,
      onInput: (value) =>
        host.dispatchEvent(SessionUiEvents.surface({ kind: 'search', value })),
    })}
  </div>`;
}

// The Subagents workbench tab: the selected stream's root subtree, drawn by
// the same `stream-tabs` the rail uses. Navigation only: an approval stays in
// the child's own request panel, and selecting a row there is the one way in.

import { html, nothing, type TemplateResult } from 'lit';

import type { StreamTabId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { waIcon } from '@shared/wa/webAwesomeIcons';

export interface SubagentsPaneModel {
  readonly view: SessionView;
  readonly surface: Surface;
  /** The stream whose family the tab shows; null when nothing is selected. */
  readonly selected: StreamTabId | null;
}

export function subagentsPaneTemplate(
  model: SubagentsPaneModel,
): TemplateResult {
  const selected =
    model.selected == null ? undefined : model.view.streams.get(model.selected);
  if (!selected) {
    return html`<div class="task-subagents-empty">
      Select a task to see the agents it dispatched.
    </div>`;
  }
  const rootId = selected.ancestors[0]?.id ?? selected.id;
  const path = [
    ...selected.ancestors.map((entry) => entry.label),
    selected.label,
  ];
  return html`
    <div class="task-subagents">
      <div class="task-subagents-path">
        ${path.map(
          (label, index) => html`
            ${index > 0 ? waIcon('chevron-right') : nothing}
            <span class=${index === path.length - 1 ? 'is-current' : ''}
              >${label}</span
            >
          `,
        )}
      </div>
      <stream-tabs
        .view=${model.view}
        .surface=${model.surface}
        .root=${rootId}
      ></stream-tabs>
      <div class="task-subagents-note">
        Approvals stay in the child's request panel; this tab only navigates.
      </div>
    </div>
  `;
}

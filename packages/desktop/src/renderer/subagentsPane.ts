// The Subagents workbench tab: the selected run's root subtree, drawn by
// the same `run-tabs` the rail uses. Navigation only: an approval stays in
// the child's own request panel, and selecting a row there is the one way in.

import { html, nothing, type TemplateResult } from 'lit';

import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { waIcon } from '@ui/wa/webAwesomeIcons';

import { WORKBENCH_KIND_META } from '../shared/desktopShellState.js';
import type { RailProject } from './desktopShell';

export interface SubagentsPaneModel {
  readonly view: SessionView;
  readonly surface: Surface;
  /** The run whose family the tab shows; null when nothing is selected. */
  readonly selected: RunId | null;
}

export function subagentsPaneTemplate(
  model: SubagentsPaneModel,
): TemplateResult {
  const selected =
    model.selected == null ? undefined : model.view.runs.get(model.selected);
  if (!selected) {
    return html`<div class="shell-subagents-empty">
      Select a task to see its subagents.
    </div>`;
  }
  const rootId = selected.ancestors[0]?.id ?? selected.id;
  const path = [
    ...selected.ancestors.map((entry) => entry.label),
    selected.label,
  ];
  return html`
    <div class="shell-subagents">
      <div class="shell-subagents-path">
        ${path.map(
          (label, index) => html`
            ${index > 0 ? waIcon('chevron-right') : nothing}
            <span class=${index === path.length - 1 ? 'is-current' : ''}
              >${label}</span
            >
          `,
        )}
      </div>
      <run-tabs
        .view=${model.view}
        .surface=${model.surface}
        .root=${rootId}
      ></run-tabs>
      <div class="shell-subagents-note">
        Select a subagent to open its conversation and answer its requests
        there.
      </div>
    </div>
  `;
}

/**
 * The way into the selected conversation's subagents: the Subagents tab
 * holds the tree, so this only opens it. Nothing when the conversation has
 * no children.
 */
export function subagentsButtonTemplate(
  project: RailProject | undefined,
  onOpen: () => void,
): TemplateResult | typeof nothing {
  if (!project) return nothing;
  const { selected } = project.surface;
  const run = selected === null ? undefined : project.view.runs.get(selected);
  const rootId = run?.ancestors[0]?.id ?? run?.id;
  const root = rootId === undefined ? undefined : project.view.runs.get(rootId);
  if (root === undefined || root.rollup.total === 0) return nothing;
  const { icon, label } = WORKBENCH_KIND_META.subagents;
  return html`
    <wa-button
      type="button"
      class="shell-subagents-open btn-secondary"
      appearance="outlined"
      size="s"
      title="Show this task's subagents"
      @click=${onOpen}
    >
      ${waIcon(icon, { slot: 'start' })}
      <span>${label}</span>
      <span class="shell-subagents-open-count" slot="end"
        >${root.rollup.total}</span
      >
    </wa-button>
  `;
}

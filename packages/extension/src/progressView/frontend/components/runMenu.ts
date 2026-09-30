// The one run menu: the items the conversation header's `⋯` and a desktop
// rail row's `⋯` (or right-click) both render from the run's `actions`, and
// what choosing one does.
import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import type { RunView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { formatWorkflowRunContext } from '@ui/copy/workflowRunContext';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';

import {
  NEUTRAL_RUN_ACTIONS,
  RUN_MENU_ACTIONS,
  type RunMenuAction,
} from '../constants';

/** The menu values of the Trash items and the permanent delete. */
const TRASH = 'trashSession';
const UNTRASH = 'untrashSession';
const DELETE = 'deleteSession';

/** An agent run's menu lists its category's actions, a process's or a
 *  workflow container's the neutral ones, each only while `actions` holds
 *  it. Edit as new task lives in the conversation's ended line. */
function menuActions(run: RunView): readonly RunMenuAction[] {
  return (
    run.identity.kind === 'agent'
      ? RUN_MENU_ACTIONS[run.category]
      : NEUTRAL_RUN_ACTIONS
  ).filter((action) => run.actions.includes(action.action));
}

/** What Copy run context copies: a workflow run's files; nothing otherwise. */
function runContextText(run: RunView): string {
  if (run.category !== 'workflow') return '';
  return formatWorkflowRunContext({
    run: {
      label: run.label,
      model: run.model ?? undefined,
      modelLabel: run.modelLabel ?? undefined,
      runId: run.id,
      description: run.description ?? undefined,
    },
    files: run.files,
    compileFailures: run.compileFailures,
  });
}

/**
 * The run's items: its actions, then `windowItems` (the header's shell
 * items), then the Trash items and the permanent delete. Nothing asks
 * before Move to Trash, since Restore undoes it.
 */
export function renderRunMenuItems(
  run: RunView,
  copy: CopyButtonController,
  windowItems: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  const noContext = runContextText(run) === '';
  const lifecycle = [
    run.actions.includes('trash')
      ? html`<wa-dropdown-item value=${TRASH}
          >${waIcon('trash', { slot: 'icon' })}Move to Trash</wa-dropdown-item
        >`
      : nothing,
    run.actions.includes('untrash')
      ? html`<wa-dropdown-item value=${UNTRASH}
          >${waIcon('arrow-rotate-left', { slot: 'icon' })}Restore from
          Trash</wa-dropdown-item
        >`
      : nothing,
    run.actions.includes('delete')
      ? html`<wa-dropdown-item value=${DELETE} variant="danger"
          >${waIcon('trash', { slot: 'icon' })}${
            run.trashedAt === null ? 'Delete session…' : 'Delete permanently…'
          }</wa-dropdown-item
        >`
      : nothing,
  ].filter((item) => item !== nothing);
  return html`${repeat(
    menuActions(run),
    (action) => action.id,
    (action) => {
      const isCopy = action.arm === 'copyRunContext';
      return html`<wa-dropdown-item
        value=${action.id}
        ?disabled=${isCopy && noContext}
        >${waIcon(isCopy && copy.state.copied ? 'check' : action.icon, {
          slot: 'icon',
        })}${action.label}</wa-dropdown-item
      >`;
    },
  )}${windowItems}${
    lifecycle.length > 0 ? html`<wa-divider></wa-divider>${lifecycle}` : nothing
  }`;
}

/**
 * Do what the chosen item `value` names, dispatched from `host`: `delete`
 * means the permanent delete was chosen and the caller asks first;
 * `unknown`, that the value is none of the run's items.
 */
export function selectRunMenuItem(
  host: HTMLElement,
  run: RunView,
  value: string,
  copy: CopyButtonController,
): 'done' | 'delete' | 'unknown' {
  const runId = run.id;
  if (value === DELETE) return 'delete';
  if (value === TRASH || value === UNTRASH) {
    host.dispatchEvent(
      SessionUiEvents.runtime({
        kind: value === TRASH ? 'run.trash' : 'run.untrash',
        runId,
      }),
    );
    return 'done';
  }
  const action = menuActions(run).find((candidate) => candidate.id === value);
  if (!action) return 'unknown';
  if (action.arm === 'copyRunContext') {
    void copy.copy(runContextText(run));
  } else if (action.arm === 'run.compact') {
    host.dispatchEvent(SessionUiEvents.runtime({ kind: 'run.compact', runId }));
  } else {
    host.dispatchEvent(SessionUiEvents.host({ kind: action.arm, runId }));
  }
  return 'done';
}

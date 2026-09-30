// The Trash: every open project's trashed conversations, each with Restore
// and Delete permanently, and Empty Trash; and the Undo toast a move to the
// Trash raises. The list is each project's `view.trash`, folded from its
// rows; this module holds only whether the dialog is open and what it asks.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '@awesome.me/webawesome/dist/components/toast-item/toast-item.js';
import { html, nothing, render, type TemplateResult } from 'lit';

import { renderDeleteSessionConfirm } from '@progressView/frontend/components/deleteSessionConfirm';
import type { SessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import type { RunId } from '@shared/schemas';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import type { RunView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { renderEmptyState } from '@ui/wa/emptyState';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { formatResultCount } from '@utils/text/stringUtils';

import type { RailProject } from './desktopShell';

/** How long the Undo toast stays up, unless hovered or focused. */
const UNDO_TOAST_MS = 6000;

/** The question the Trash is asking, if any. */
type TrashQuestion = { readonly runId: RunId } | 'empty' | null;

interface TrashModel {
  readonly open: boolean;
  readonly projects: readonly RailProject[];
  readonly question: TrashQuestion;
}

interface TrashCallbacks {
  onAsk(question: TrashQuestion): void;
  /** Delete every listed conversation for good, once asked. */
  onEmpty(): void;
  onClose(): void;
}

function trashedRuns(project: RailProject): RunView[] {
  return project.view.trash.flatMap((id) => project.view.runs.get(id) ?? []);
}

function trashRow(
  run: RunView,
  question: TrashQuestion,
  callbacks: TrashCallbacks,
): TemplateResult {
  const title = run.description || run.label;
  const asking = question !== null && question !== 'empty';
  return html`<li class="desktop-trash-row" data-run=${run.id}>
    <div class="desktop-trash-row-main">
      <span class="desktop-trash-title" title=${title}>${title}</span>
      <span class="desktop-trash-when"
        >Trashed
        <wa-relative-time
          .date=${new Date(run.trashedAt ?? run.launchedAt)}
          sync
        ></wa-relative-time
      ></span>
    </div>
    <div class="desktop-trash-actions">
      <wa-button
        class="desktop-trash-restore"
        appearance="outlined"
        size="s"
        @click=${(event: Event) =>
          (event.currentTarget as HTMLElement).dispatchEvent(
            SessionUiEvents.runtime({ kind: 'run.untrash', runId: run.id }),
          )}
        >${waIcon('arrow-rotate-left', { slot: 'start' })}Restore</wa-button
      >
      <wa-button
        class="desktop-trash-delete"
        appearance="plain"
        variant="danger"
        size="s"
        @click=${() => callbacks.onAsk({ runId: run.id })}
        >Delete permanently</wa-button
      >
    </div>
    ${
      asking && question.runId === run.id
        ? renderDeleteSessionConfirm(run, () => callbacks.onAsk(null))
        : nothing
    }
  </li>`;
}

function trashDialogTemplate(
  model: TrashModel,
  callbacks: TrashCallbacks,
): TemplateResult {
  const sections = model.projects.flatMap((project) => {
    const runs = trashedRuns(project);
    return runs.length === 0 ? [] : [{ project, runs }];
  });
  const count = sections.reduce((sum, { runs }) => sum + runs.length, 0);
  return html`<wa-dialog
    class="desktop-trash"
    label="Trash"
    light-dismiss
    ?open=${model.open}
    @wa-after-hide=${(event: Event) => {
      if (event.target === event.currentTarget) callbacks.onClose();
    }}
  >
    <p class="desktop-trash-note">
      Conversations in the Trash are deleted permanently after 30 days.
    </p>
    ${
      count === 0
        ? renderEmptyState({
            icon: 'trash',
            title: 'The Trash is empty',
            body: 'Conversations you move to the Trash appear here.',
            headingTag: 'h3',
          })
        : sections.map(
            ({ project, runs }) =>
              html`<section
                class="desktop-trash-project"
                data-session=${project.display.key}
              >
                <h3 class="desktop-trash-project-name">
                  ${project.display.name}
                </h3>
                <ul class="desktop-trash-list">
                  ${runs.map((run) => trashRow(run, model.question, callbacks))}
                </ul>
              </section>`,
          )
    }
    ${
      model.question === 'empty'
        ? html`<wa-callout
            class="desktop-trash-empty-confirm"
            variant="danger"
            size="small"
            role="alertdialog"
            aria-label="Empty Trash"
          >
            ${waIcon('trash', { slot: 'icon' })} Delete
            ${formatResultCount(count, 'conversation')} permanently? Their
            conversations and run folders are removed for good.
            <div class="delete-confirm-actions">
              <wa-button
                id="confirmEmptyTrash"
                variant="danger"
                size="s"
                @click=${callbacks.onEmpty}
                >Empty Trash</wa-button
              >
              <wa-button
                appearance="plain"
                size="s"
                @click=${() => callbacks.onAsk(null)}
                >Cancel</wa-button
              >
            </div>
          </wa-callout>`
        : nothing
    }
    <wa-button
      slot="footer"
      class="desktop-trash-empty"
      appearance="outlined"
      variant="danger"
      size="s"
      ?disabled=${count === 0}
      @click=${() => callbacks.onAsk('empty')}
      >Empty Trash</wa-button
    >
  </wa-dialog>`;
}

/**
 * The Trash of every open project. `request` is the shell's one runtime
 * request path: a move to the Trash that the runtime carried out leaves the
 * conversation if it was on screen and raises Undo.
 */
export function createTrash(deps: {
  readonly sessions: SessionSurfaces;
  readonly projects: () => readonly RailProject[];
  /** The dialog opened, closed, or changed its question. */
  readonly onChange: () => void;
}) {
  let open = false;
  let question: TrashQuestion = null;
  const toast = document.createElement('wa-toast');
  toast.placement = 'bottom-start';
  document.body.append(toast);

  const set = (next: { open?: boolean; question?: TrashQuestion }) => {
    open = next.open ?? open;
    question = next.question ?? null;
    deps.onChange();
  };

  function raiseUndo(key: string, run: RunView): void {
    const item = document.createElement('wa-toast-item');
    item.duration = UNDO_TOAST_MS;
    item.classList.add('desktop-trash-toast');
    render(
      html`${waIcon('trash', { slot: 'icon' })}
        <span class="desktop-trash-toast-text"
          >Moved “${run.description || run.label}” to Trash</span
        >
        <wa-button
          class="desktop-trash-undo"
          appearance="plain"
          variant="brand"
          size="s"
          @click=${() => {
            void item.hide();
            void deps.sessions.runtimeRequest(key, {
              kind: 'run.untrash',
              runId: run.id,
            });
          }}
          >Undo</wa-button
        >`,
      item,
    );
    toast.append(item);
  }

  return {
    template: () =>
      trashDialogTemplate(
        { open, projects: deps.projects(), question },
        {
          onAsk: (next) => set({ question: next }),
          onEmpty: () => {
            for (const project of deps.projects())
              for (const runId of project.view.trash)
                void deps.sessions.runtimeRequest(project.display.key, {
                  kind: 'run.delete',
                  runId,
                });
            set({});
          },
          onClose: () => set({ open: false }),
        },
      ),
    open: () => set({ open: true }),
    isOpen: () => open,
    async request(key: string, request: RuntimeRequest): Promise<void> {
      const session = deps.sessions.get(key);
      const run =
        request.kind === 'run.trash'
          ? session?.view$.get().runs.get(request.runId)
          : undefined;
      const ok = await deps.sessions.runtimeRequest(key, request);
      if (!ok || !session || !run) return;
      // The conversation left the list: the one on screen moves to the
      // project's first remaining one, as a delete's does.
      if (session.surface$.get().selected === run.id) {
        const next = session.view$.get().order.find((id) => id !== run.id);
        deps.sessions.act(key, { kind: 'select', runId: next ?? null });
      }
      raiseUndo(key, run);
    },
  };
}

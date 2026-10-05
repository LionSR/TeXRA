/**
 * What every run kind's content shares: the run, the view, the
 * surface, and the host snapshot as properties, the request dock filtered
 * to this run, the transcript, the usage footer, and the line that stands
 * where the composer would for a run that takes no follow-up.
 */
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

import type { PermissionPayload } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  isLiveRun,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@texra/shared/session/uiEvents';
import { interruptedTasks, resumeBlockerFix } from '@ui/copy/interruptedTasks';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { ForkFromHere } from './UserMessage';
import './InterruptedTasksNotice';
import './RequestPanels';
import './LogList';
import './UsagePanel';

export abstract class BaseRunContent extends LitElement {
  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** The app renders a conversation only once the first snapshot is in
   *  (`ProgressApp.render`), so there is no null arm here. */
  @property({ attribute: false }) host!: HostSnapshot;

  /** The pending requests this run has open, in the fold's request order:
   *  oldest first, the newest last. */
  protected get runPermissions(): PermissionPayload[] {
    const run = this.run;
    if (!run || !this.view) return [];
    return this.view.requests
      .filter((request) => request.runId === run.id)
      .map((request) => request.payload);
  }

  protected renderApprovalDock(): TemplateResult | typeof nothing {
    const permissions = this.runPermissions;
    if (permissions.length === 0) return nothing;
    return html`
      <div class="conversation-column conversation-approval-dock">
        <request-panels
          .permissions=${permissions}
          .surface=${this.surface}
          .run=${this.run}
        ></request-panels>
      </div>
    `;
  }

  protected renderLog(): TemplateResult {
    return html`<div
      class="conversation-log"
      style=${this.run?.actions.includes('fork') ? '' : '--texra-fork-from-here: none'}
      @fork-from-here=${(event: CustomEvent<ForkFromHere>) => {
        const run = this.run;
        if (!run?.actions.includes('fork')) return;
        this.dispatchEvent(
          SessionUiEvents.host({
            kind: 'fork',
            runId: run.id,
            at: event.detail.at,
            draft: event.detail.draft,
          }),
        );
      }}
    >
      <log-list
        .run=${this.run}
        .view=${this.view}
        .surface=${this.surface}
      ></log-list>
    </div>`;
  }

  /**
   * The line in the composer's place for a run that takes no follow-up:
   * why (the fold's detail, else ended or no replies), then what the user
   * can do. A run that resumes has its one Resume here, and a blocked one
   * the fix its detail names; a conversation forks into a new task holding
   * its history (there is no prefilled "new task from this": the composer
   * already starts one). Each is offered only while the run's `actions`
   * holds it.
   */
  protected renderEndedLine(run: RunView): TemplateResult {
    const live = isLiveRun(run);
    // What a blocked resume waits for has its fix in Settings › Plugins.
    const fix = run.resumeBlocked && resumeBlockerFix(run.resumeBlocked);
    const request = (kind: 'resume') => () =>
      this.dispatchEvent(SessionUiEvents.host({ kind, runId: run.id }));
    return html`<div class="conversation-ended">
      <span role="status" aria-atomic="true"
        >${
          run.statusDetail ??
          (live
            ? `This ${run.parentId === null ? 'task' : 'agent'} takes no messages.`
            : `This ${run.parentId === null ? 'task' : 'agent'} has ended.`)
        }</span
      >
      ${
        // The task's one Resume (an interrupted task, a workflow from its
        // saved outputs, a stopped background script: `runActions`).
        run.actions.includes('resume')
          ? html`<wa-button
              id="resumeRunBtn"
              variant="brand"
              size="s"
              @click=${request('resume')}
              >${waIcon('forward-step', { slot: 'start' })}Resume</wa-button
            >`
          : nothing
      }
      ${
        fix
          ? html`<wa-button
              id="resumeBlockerFixBtn"
              appearance="outlined"
              variant="neutral"
              size="s"
              @click=${() =>
                this.dispatchEvent(
                  SessionUiEvents.host({
                    kind: 'openSettings',
                    section: 'plugins',
                  }),
                )}
              >${fix}</wa-button
            >`
          : nothing
      }
      ${
        run.actions.includes('fork')
          ? html`<wa-button
              id="forkTaskBtn"
              appearance="outlined"
              variant="neutral"
              size="s"
              @click=${() =>
                this.dispatchEvent(
                  SessionUiEvents.host({ kind: 'fork', runId: run.id }),
                )}
              >${waIcon('code-branch', { slot: 'start' })}${
                TASK_ACTIONS.fork
              }</wa-button
            >`
          : nothing
      }
    </div>`;
  }

  /** The notice's own dock, for a run with no composer or ended line (a
   *  process, a running workflow): nothing while no task is listed. */
  protected renderInterruptedDock(): TemplateResult | typeof nothing {
    if (
      !this.view ||
      interruptedTasks(this.view, this.surface?.interruptedDismissed).length ===
        0
    )
      return nothing;
    return html`<div class="conversation-composer-dock">
      <div class="conversation-column">${this.renderInterruptedNotice()}</div>
    </div>`;
  }

  /** A fork's first line: the task and the point it was cut at, since its
   *  transcript starts empty (the model's view is the source's). */
  protected renderForkedFrom(run: RunView): TemplateResult | typeof nothing {
    const source = run.forkedFrom;
    if (source === null) return nothing;
    const from = this.view?.runs.get(source.id);
    const title = from ? from.description || from.label : 'a deleted task';
    return html`<p class="forked-from-line">
      ${waIcon('code-branch')} ${TASK_ACTIONS.forkedFrom(title)} at step
      ${source.at}: the model holds that conversation up to there.
    </p>`;
  }

  /** The open-time notice, above the composer or the ended line. */
  protected renderInterruptedNotice(): TemplateResult {
    return html`<interrupted-tasks-notice
      .view=${this.view}
      .surface=${this.surface}
    ></interrupted-tasks-notice>`;
  }

  protected renderUsagePanel(run: RunView): TemplateResult {
    return html`<usage-panel
      .usage=${run.treeUsage}
      .ownUsage=${run.usage}
      .contextState=${run.context}
    ></usage-panel>`;
  }
}

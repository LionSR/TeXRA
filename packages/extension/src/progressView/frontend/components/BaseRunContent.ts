/**
 * What every run kind's content shares: the run, the view, the
 * surface, and the host snapshot as properties, the request dock filtered
 * to this run, the transcript, the usage footer, and the line that stands
 * where the composer would for a run that takes no follow-up.
 */
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

import { isPlainAgentIdentity, type PermissionPayload } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import {
  isLiveRun,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@awesome.me/webawesome/dist/components/button/button.js';
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
    return html`<div class="conversation-log">
      <log-list .run=${this.run} .surface=${this.surface}></log-list>
    </div>`;
  }

  /**
   * The line in the composer's place for a run that takes no follow-up:
   * why (the fold's detail, else ended or no replies), then what the user
   * can do. An interrupted run resumes; a run that has stopped, however it
   * stopped, starts a new task from its setup (the launcher prefilled with
   * its agent and instruction). This is the one home of Edit as new task.
   * Both reach the host's `nativeAgentRun` gate, which admits a plain agent
   * identity and nothing else, and neither is offered on a run this process
   * may not act on.
   */
  protected renderEndedLine(run: RunView): TemplateResult {
    const live = isLiveRun(run);
    const actionable =
      !live && !run.readOnly && isPlainAgentIdentity(run.identity);
    const request = (kind: 'resume' | 'restoreIntoLauncher') => () =>
      this.dispatchEvent(SessionUiEvents.host({ kind, runId: run.id }));
    return html`<div class="conversation-ended">
      <span role="status" aria-atomic="true"
        >${
          run.statusDetail ??
          (live ? 'This session takes no messages.' : 'This session has ended.')
        }</span
      >
      ${
        actionable && run.group === 'interrupted'
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
        actionable
          ? html`<wa-button
              id="editAsNewTaskBtn"
              appearance="outlined"
              variant="neutral"
              size="s"
              @click=${request('restoreIntoLauncher')}
              >${waIcon('reply', { slot: 'start' })}Edit as new task</wa-button
            >`
          : nothing
      }
    </div>`;
  }

  protected renderUsagePanel(run: RunView): TemplateResult {
    return html`<usage-panel
      .usage=${run.usage}
      .contextState=${run.context}
    ></usage-panel>`;
  }
}

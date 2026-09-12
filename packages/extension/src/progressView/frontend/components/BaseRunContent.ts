/**
 * What every run kind's content shares: the run, the view, the
 * surface, and the host snapshot as properties, the request dock filtered
 * to this run, the transcript, and the usage footer.
 */
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

import type { PermissionPayload } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
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
  /** The host's clock, for elapsed readings (G4). */
  @property({ type: Number }) nowMs: number | null = null;

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
          .view=${this.view}
          .surface=${this.surface}
          .readOnly=${this.run?.readOnly === true}
        ></request-panels>
      </div>
    `;
  }

  protected renderLog(): TemplateResult {
    return html`<div class="conversation-log">
      <log-list .run=${this.run} .surface=${this.surface}></log-list>
    </div>`;
  }

  protected renderUsagePanel(run: RunView): TemplateResult {
    return html`<usage-panel
      .usage=${run.usage}
      .contextState=${run.context}
    ></usage-panel>`;
  }
}

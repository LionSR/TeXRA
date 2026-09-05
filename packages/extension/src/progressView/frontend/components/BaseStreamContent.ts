/**
 * What every stream kind's content shares: the stream, the view, the
 * surface, and the host snapshot as properties, the approval dock filtered
 * to this stream, the transcript, and the usage footer.
 */
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

import type { PermissionPayload } from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';
import { totalRunUsage } from '../stateUtils';
import './RequestPanels';
import './LogList';
import './UsagePanel';

export abstract class BaseStreamContent extends LitElement {
  @property({ attribute: false }) stream: StreamView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** The host's clock, for elapsed readings (G4). */
  @property({ type: Number }) nowMs: number | null = null;

  /** The pending approvals asked by this stream, in request order. */
  protected get streamPermissions(): PermissionPayload[] {
    const stream = this.stream;
    if (!stream || !this.view) return [];
    return this.view.approvals
      .filter((approval) => approval.streamId === stream.id)
      .map((approval) => approval.payload);
  }

  protected renderApprovalDock(): TemplateResult | typeof nothing {
    const permissions = this.streamPermissions;
    if (permissions.length === 0) return nothing;
    return html`
      <div class="conversation-column conversation-approval-dock">
        <request-panels
          .permissions=${permissions}
          .view=${this.view}
          .readOnly=${this.stream?.readOnly === true}
        ></request-panels>
      </div>
    `;
  }

  protected renderLog(): TemplateResult {
    return html`<div class="conversation-log">
      <log-list .stream=${this.stream} .surface=${this.surface}></log-list>
    </div>`;
  }

  protected renderUsagePanel(stream: StreamView): TemplateResult {
    return html`<usage-panel
      .usage=${totalRunUsage(stream.usage)}
      .contextState=${stream.context}
    ></usage-panel>`;
  }
}

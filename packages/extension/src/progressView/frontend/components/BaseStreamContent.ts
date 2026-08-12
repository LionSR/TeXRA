/**
 * Shared scaffolding for stream container components: consumes the stream and
 * permission contexts and keeps `filteredPermissions` scoped to the current
 * stream. Subclasses narrow `streamContext.streamState` and render.
 */

// Third-party imports
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { state } from 'lit/decorators.js';

// Local imports - shared schemas
import type { ContextStateData, TokenUsageStats } from '@shared/schemas';

// Local imports - progress view
import { filterPermissionsForStream, totalRunUsage } from '../stateUtils';
import {
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
} from '../streamContexts';

// Local imports - types
import type { PermissionState } from '../permissionState';

// Side-effect imports - sibling components shared by both stream-content
// containers (registered once, consumed by the render helpers below)
import './RequestPanels';
import './LogList';
import './UsagePanel';

export abstract class BaseStreamContent extends LitElement {
  @consume({ context: streamStateContext, subscribe: true })
  @state()
  protected streamContext: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @consume({ context: permissionsContext, subscribe: true })
  @state()
  protected permissionContext: PermissionState[] = [];

  // Derived values - recomputed in willUpdate() before render.
  protected filteredPermissions: PermissionState[] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (
      changedProperties.has('streamContext') ||
      changedProperties.has('permissionContext')
    ) {
      this.filteredPermissions = filterPermissionsForStream(
        this.permissionContext,
        this.streamContext.streamInfo?.name,
      );
    }
  }

  /** Pending-approval dock, shared verbatim by the two stream-content renders. */
  protected renderApprovalDock(): TemplateResult | typeof nothing {
    if (this.filteredPermissions.length === 0) return nothing;
    return html`
      <div class="conversation-column conversation-approval-dock">
        <request-panels .permissions=${this.filteredPermissions}></request-panels>
      </div>
    `;
  }

  /** The transcript log column, shared verbatim by the two stream-content renders. */
  protected renderLog(): TemplateResult {
    return html`<div class="conversation-log"><log-list></log-list></div>`;
  }

  /** Session-total usage panel, shared by the two stream-content renders. */
  protected renderUsagePanel(
    runUsage: Record<string, TokenUsageStats>,
    contextState: ContextStateData | undefined,
  ): TemplateResult {
    return html`<usage-panel
      .usage=${totalRunUsage(runUsage)}
      .contextState=${contextState ?? null}
    ></usage-panel>`;
  }
}

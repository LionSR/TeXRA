/** Container component for workflow agent streams. */

// Third-party imports
import {
  LitElement,
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

// Local imports - progress view
import { filterPermissionsForStream, hasOutputFiles } from '../stateUtils';
import {
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';
import type { WorkflowStreamState } from '../store';

// Local imports - types
import type { PermissionState } from './PermissionCard';

// Side-effect imports - sibling components
import './StreamHeader';
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './FileList';
import './WorkflowToolUseFollowupSection';
import './BackgroundTasksPanel';
import './RequestPanels';
import './WorkflowHintBanner';

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @consume({ context: streamStateContext, subscribe: true })
  @state()
  private streamContext: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @consume({ context: permissionsContext, subscribe: true })
  @state()
  private permissionContext: PermissionState[] = [];

  // Derived values - recomputed in willUpdate() before render.
  private filteredPermissions: PermissionState[] = [];

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

  private get currentState(): WorkflowStreamState | null {
    const ctx = this.streamContext;
    if (ctx.isToolUse || !ctx.streamState) return null;
    return ctx.streamState as WorkflowStreamState;
  }

  override render(): TemplateResult | typeof nothing {
    const streamInfo = this.streamContext.streamInfo;
    const state = this.currentState;

    if (!streamInfo || !state) {
      return nothing;
    }

    return html`
      <stream-header
        .stream=${streamInfo}
        .status=${state.status}
        .progress=${state.conversationProgress}
        .yoloActive=${false}
      ></stream-header>

      <workflow-hint-banner></workflow-hint-banner>

      <request-panels .permissions=${this.filteredPermissions}></request-panels>

      <background-tasks-panel
        .activeProcesses=${state.activeProcesses}
        .finishedProcessCount=${state.finishedProcessCount}
        .activeSubagents=${state.activeSubagents}
        .finishedSubagentCount=${state.finishedSubagentCount}
      ></background-tasks-panel>

      <log-list></log-list>

      <usage-panel
        .usage=${state.sessionUsage ?? null}
        .contextState=${state.contextState ?? null}
      ></usage-panel>

      <file-list
        .filesByRound=${state.files}
        .failuresByRound=${state.compileFailures}
        .showRoundHeaders=${true}
      ></file-list>

      <workflow-tool-use-followup-section
        .status=${state.status}
        .hasOutputFiles=${hasOutputFiles(state.files)}
        .options=${this.streamContext.followupOptions}
        .streamModel=${streamInfo.model ?? null}
      ></workflow-tool-use-followup-section>
    `;
  }
}

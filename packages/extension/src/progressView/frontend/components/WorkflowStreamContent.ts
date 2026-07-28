/** Container component for workflow agent streams. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - progress view
import { hasOutputFiles } from '../stateUtils';
import { BaseStreamContent } from './BaseStreamContent';
import { conversationContentStyles } from './ConversationContent.styles';
import { renderStreamHeader } from './streamHeaderView';
import { isWorkflowState, type WorkflowStreamState } from '../store';

// Local imports - components

// Side-effect imports - sibling components
import './TaskGroupList';
import './LogList';
import './UsagePanel';
import './FileList';
import './WorkflowToolUseFollowupSection';
import './BackgroundTasksPanel';
import './RequestPanels';

@customElement('workflow-stream-content')
export class WorkflowStreamContent extends BaseStreamContent {
  static override styles = conversationContentStyles;

  private get currentState(): WorkflowStreamState | null {
    const { streamState } = this.streamContext;
    return streamState && isWorkflowState(streamState) ? streamState : null;
  }

  override render(): TemplateResult | typeof nothing {
    const streamInfo = this.streamContext.streamInfo;
    const state = this.currentState;

    if (!streamInfo || !state) {
      return nothing;
    }

    return html`
      ${renderStreamHeader(
        streamInfo,
        state,
        this.streamContext.unsupportedCommands,
      )}

      <div class="conversation-content">
        <div class="conversation-column conversation-prelude">
          <request-panels
            .permissions=${this.filteredPermissions}
          ></request-panels>

          <background-tasks-panel scope="inquiries"></background-tasks-panel>
        </div>

        <div class="conversation-log"><log-list></log-list></div>

        <div class="conversation-column conversation-epilogue">
          <usage-panel
            .usage=${state.sessionUsage ?? null}
            .contextState=${state.contextState ?? null}
          ></usage-panel>

          <file-list
            .filesByRound=${state.files}
            .failuresByRound=${state.compileFailures}
            .unsupportedCommands=${this.streamContext.unsupportedCommands}
          ></file-list>

          <workflow-tool-use-followup-section
            .status=${state.status}
            .hasOutputFiles=${hasOutputFiles(state.files)}
            .options=${this.streamContext.followupOptions}
            .streamModel=${
              streamInfo.kind === 'agent' ? (streamInfo.model ?? null) : null
            }
            .unsupportedCommands=${this.streamContext.unsupportedCommands}
          ></workflow-tool-use-followup-section>
        </div>
      </div>
    `;
  }
}

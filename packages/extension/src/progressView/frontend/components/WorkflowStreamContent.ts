/** Container component for workflow agent streams. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared schemas
import { isWorkflowState, type WorkflowStreamState } from '@shared/schemas';

// Local imports - progress view
import { BaseStreamContent } from './BaseStreamContent';
import { conversationContentStyles } from './ConversationContent.styles';

// Side-effect imports - register the <stream-header> element
import './StreamHeader';

// Side-effect imports - sibling components
import './TaskGroupList';
import './FileList';
import './BackgroundTasksPanel';

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
      <stream-header
        .stream=${streamInfo}
        .state=${state}
        .unsupportedCommands=${this.streamContext.unsupportedCommands}
      ></stream-header>

      <div class="conversation-content">
        ${this.renderApprovalDock()}

        <div class="conversation-column conversation-prelude">
          <background-tasks-panel scope="inquiries"></background-tasks-panel>
        </div>

        ${this.renderLog()}

        <div class="conversation-column conversation-epilogue">
          ${this.renderUsagePanel(state.runUsage, state.contextState)}

          <file-list
            .filesByRound=${state.files}
            .failuresByRound=${state.compileFailures}
            .unsupportedCommands=${this.streamContext.unsupportedCommands}
          ></file-list>
        </div>
      </div>
    `;
  }
}

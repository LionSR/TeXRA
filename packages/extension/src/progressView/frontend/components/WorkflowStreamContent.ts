/** Container component for workflow agent streams. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - progress view
import { hasOutputFiles } from '../stateUtils';
import { BaseStreamContent } from './BaseStreamContent';
import type { WorkflowStreamState } from '../store';

// Local imports - components

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
export class WorkflowStreamContent extends BaseStreamContent {
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
        .substate=${state.substate}
        .progress=${state.conversationProgress}
        .roundStage=${state.roundStage}
        .yoloActive=${false}
        .unsupportedCommands=${this.streamContext.unsupportedCommands}
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
        .unsupportedCommands=${this.streamContext.unsupportedCommands}
      ></file-list>

      <workflow-tool-use-followup-section
        .status=${state.status}
        .hasOutputFiles=${hasOutputFiles(state.files)}
        .options=${this.streamContext.followupOptions}
        .streamModel=${streamInfo.model ?? null}
        .unsupportedCommands=${this.streamContext.unsupportedCommands}
      ></workflow-tool-use-followup-section>
    `;
  }
}

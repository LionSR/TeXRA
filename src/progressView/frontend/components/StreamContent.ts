/**
 * Shared stream content renderer for tool-use and workflow streams.
 *
 * Renders shared sections (header, request panels, log list, usage panel)
 * and inserts stream-specific sections via normalized section descriptors.
 */

// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ref, type Ref } from 'lit/directives/ref.js';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view utilities
import type { RunGroup } from '../stateUtils';

// Local imports - progress view store (type-only)
import type { FollowupMode, FollowupOptionsState } from '../store';

// Local imports - shared schemas
import type {
  ContextState,
  InstructionUpdate,
  OutputFileInfo,
  StreamState,
  StreamTabInfo,
  TokenUsageStats,
  TodoItem,
} from '@shared/schemas';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';
import type { FollowUpInput } from './FollowUpInput';

// Local imports - sibling components
import './StreamHeader';
import './RequestPanels';
import './TodoList';
import './LogList';
import './UsagePanel';
import './FollowUpInput';
import './InstructionPanel';
import './FileList';
import './FollowupSection';

export type StreamSectionPlacement = 'preRequest' | 'postRequest' | 'postUsage';

export type StreamSection =
  | {
      type: 'instruction';
      placement: 'preRequest';
      instruction: InstructionUpdate | null;
    }
  | {
      type: 'todos';
      placement: 'postRequest';
      todos: TodoItem[];
    }
  | {
      type: 'files';
      placement: 'postUsage';
      filesByRound: Record<string, OutputFileInfo[]>;
      showRoundHeaders: boolean;
    }
  | {
      type: 'followupInput';
      placement: 'postUsage';
      followUp: {
        visible: boolean;
        value: string;
        queuedMessages: string[];
        shouldFocus: boolean;
        polishedText: string | null;
        transcribedText: string | null;
        recording: boolean;
      };
      followUpRef?: Ref<FollowUpInput>;
    }
  | {
      type: 'followupSection';
      placement: 'postUsage';
      followUp: {
        agentCategory: StreamTabInfo['agentCategory'];
        status: string;
        hasOutputFiles: boolean;
        options: FollowupOptionsState | null;
        mode: FollowupMode;
        streamModel: string | null;
      };
    };

export interface NormalizedStreamData {
  header: {
    stream: StreamTabInfo;
    streamState: StreamState;
    runId: string | null;
    runs: RunGroup[];
    yoloActive: boolean;
  };
  permissions: PermissionState[];
  usage: TokenUsageStats | null;
  contextState: ContextState | null;
  sections: StreamSection[];
}

@customElement('stream-content')
export class StreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ attribute: false })
  data?: NormalizedStreamData;

  private renderSections(
    placement: StreamSectionPlacement,
    sections: StreamSection[],
  ): TemplateResult {
    const filtered = sections.filter(
      (section) => section.placement === placement,
    );
    return html`${filtered.map((section) => this.renderSection(section))}`;
  }

  private renderSection(section: StreamSection): TemplateResult {
    switch (section.type) {
      case 'instruction':
        return html`<instruction-panel
          .instruction=${section.instruction}
        ></instruction-panel>`;
      case 'todos':
        return html`<todo-list .todos=${section.todos}></todo-list>`;
      case 'files':
        return html`<file-list
          .filesByRound=${section.filesByRound}
          .showRoundHeaders=${section.showRoundHeaders}
        ></file-list>`;
      case 'followupInput': {
        const followUpRef = section.followUpRef;
        return html`<follow-up-input
          ${followUpRef ? ref(followUpRef) : nothing}
          .visible=${section.followUp.visible}
          .value=${section.followUp.value}
          .queuedMessages=${section.followUp.queuedMessages}
          .shouldFocus=${section.followUp.shouldFocus}
          .polishedText=${section.followUp.polishedText}
          .transcribedText=${section.followUp.transcribedText}
          .recording=${section.followUp.recording}
          @focus-complete=${this.handleFocusComplete}
        ></follow-up-input>`;
      }
      case 'followupSection':
        return html`<followup-section
          .agentCategory=${section.followUp.agentCategory}
          .status=${section.followUp.status}
          .hasOutputFiles=${section.followUp.hasOutputFiles}
          .options=${section.followUp.options}
          .mode=${section.followUp.mode}
          .streamModel=${section.followUp.streamModel}
        ></followup-section>`;
    }
  }

  override render(): TemplateResult {
    if (!this.data) {
      return html``;
    }

    const { header, permissions, usage, contextState, sections } = this.data;

    return html`
      <stream-header
        .stream=${header.stream}
        .streamState=${header.streamState}
        .runId=${header.runId}
        .runs=${header.runs}
        .yoloActive=${header.yoloActive}
      ></stream-header>

      ${this.renderSections('preRequest', sections)}

      <request-panels .permissions=${permissions}></request-panels>

      ${this.renderSections('postRequest', sections)}

      <log-list></log-list>

      <usage-panel .usage=${usage} .contextState=${contextState}></usage-panel>

      ${this.renderSections('postUsage', sections)}
    `;
  }

  private handleFocusComplete(): void {
    this.dispatchEvent(ProgressEvents.followupFocusComplete());
  }
}

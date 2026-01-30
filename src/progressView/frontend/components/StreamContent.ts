// Third-party imports
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
import type { Ref } from 'lit/directives/ref.js';

// Local imports - progress view store (types)
import type {
  ContextState,
  FollowupMode,
  FollowupOptionsState,
} from '../store';

// Local imports - shared schemas
import type {
  AgentCategory,
  InstructionUpdate,
  OutputFileInfo,
  StreamState,
  StreamTabInfo,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';
import type { FollowUpInput } from './FollowUpInput';
import type { RunGroup } from '../stateUtils';

// Local imports - sibling components
import './StreamHeader';
import './InstructionPanel';
import './RequestPanels';
import './TodoList';
import './LogList';
import './UsagePanel';
import './FileList';
import './FollowupSection';
import './FollowUpInput';

export interface StreamHeaderData {
  stream: StreamTabInfo;
  streamState: StreamState;
  runId: string | null;
  runs: RunGroup[];
  yoloActive: boolean;
}

export type StreamContentSection =
  | { type: 'instruction'; instruction: InstructionUpdate | null }
  | { type: 'requestPanels'; permissions: PermissionState[] }
  | { type: 'todoList'; todos: TodoItem[] }
  | { type: 'logList' }
  | {
      type: 'usagePanel';
      usage: TokenUsageStats | null;
      contextState: ContextState | null;
    }
  | {
      type: 'fileList';
      filesByRound: Record<string, OutputFileInfo[]>;
      showRoundHeaders: boolean;
    }
  | {
      type: 'followupSection';
      agentCategory: AgentCategory;
      status: string;
      hasOutputFiles: boolean;
      options: FollowupOptionsState | null;
      mode: FollowupMode;
      streamModel: string | null;
    }
  | {
      type: 'followUpInput';
      ref?: Ref<FollowUpInput>;
      visible: boolean;
      value: string;
      queuedMessages: string[];
      shouldFocus: boolean;
      polishedText: string | null;
      transcribedText: string | null;
      recording: boolean;
      onFocusComplete?: () => void;
    };

export interface NormalizedStreamData {
  header: StreamHeaderData;
  sections: StreamContentSection[];
}

@customElement('stream-content')
export class StreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @property({ type: Object })
  data?: NormalizedStreamData;

  override render(): TemplateResult {
    const data = this.data;
    if (!data) {
      return html``;
    }

    return html`
      <stream-header
        .stream=${data.header.stream}
        .streamState=${data.header.streamState}
        .runId=${data.header.runId}
        .runs=${data.header.runs}
        .yoloActive=${data.header.yoloActive}
      ></stream-header>
      ${data.sections.map((section) => this.renderSection(section))}
    `;
  }

  private renderSection(section: StreamContentSection): TemplateResult {
    switch (section.type) {
      case 'instruction':
        return html`
          <instruction-panel
            .instruction=${section.instruction}
          ></instruction-panel>
        `;
      case 'requestPanels':
        return html`
          <request-panels .permissions=${section.permissions}></request-panels>
        `;
      case 'todoList':
        return html` <todo-list .todos=${section.todos}></todo-list> `;
      case 'logList':
        return html` <log-list></log-list> `;
      case 'usagePanel':
        return html`
          <usage-panel
            .usage=${section.usage}
            .contextState=${section.contextState}
          ></usage-panel>
        `;
      case 'fileList':
        return html`
          <file-list
            .filesByRound=${section.filesByRound}
            .showRoundHeaders=${section.showRoundHeaders}
          ></file-list>
        `;
      case 'followupSection':
        return html`
          <followup-section
            .agentCategory=${section.agentCategory}
            .status=${section.status}
            .hasOutputFiles=${section.hasOutputFiles}
            .options=${section.options}
            .mode=${section.mode}
            .streamModel=${section.streamModel}
          ></followup-section>
        `;
      case 'followUpInput':
        return html`
          <follow-up-input
            ${section.ref ? ref(section.ref) : nothing}
            .visible=${section.visible}
            .value=${section.value}
            .queuedMessages=${section.queuedMessages}
            .shouldFocus=${section.shouldFocus}
            .polishedText=${section.polishedText}
            .transcribedText=${section.transcribedText}
            .recording=${section.recording}
            @focus-complete=${section.onFocusComplete}
          ></follow-up-input>
        `;
      default:
        return html``;
    }
  }
}

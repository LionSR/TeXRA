// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, query } from 'lit/decorators.js';

// Side-effect imports - production progress view components
import '@progressView/frontend/components/FileList';
import '@progressView/frontend/components/StreamHeader';
import '@progressView/frontend/components/StreamTabs';
import '@progressView/frontend/components/TaskGroupList';

// Local imports - shared types and styles
import {
  AgentCategory,
  createWorkflowStreamState,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_STATUS,
  type LogMessageData,
  type OutputFileInfo,
  type StreamState,
  type StreamTabInfo,
  type TaskGroup,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';

const ACTIVE_STREAM_ID = 'polish';
const BASE_TIME = Date.parse('2026-05-28T16:00:00Z');

/** Realistic OutputFileInfo fixture for the production <file-list>. */
function mockFile(
  relative: string,
  diff: { added: number; removed: number },
): OutputFileInfo {
  return {
    source: relative,
    location: {
      kind: 'workspace',
      absolutePath: `/workspace/${relative}`,
      relativePath: relative,
    },
    round: 1,
    lineage: null,
    diff,
  };
}

const SAMPLE_FILES: Record<string, OutputFileInfo[]> = {
  '1': [
    mockFile('manuscript_revised.tex', { added: 142, removed: 89 }),
    mockFile('abstract_draft.tex', { added: 18, removed: 0 }),
    mockFile('change_summary.md', { added: 24, removed: 0 }),
  ],
};

const SAMPLE_STREAMS: StreamTabInfo[] = [
  {
    name: ACTIVE_STREAM_ID,
    label: 'manuscript_revised.tex - polish workflow',
    modelLabel: 'Opus 4.7',
    agent: 'paper-polish',
    agentCategory: AgentCategory.Workflow,
    inputFile: 'manuscript.tex',
    creationTimestamp: BASE_TIME,
    executionId: 'abc123',
  },
  {
    name: 'figures',
    label: 'figures.tex - tikz tighten',
    modelLabel: 'Sonnet 4.5',
    agent: 'latex-fixer',
    agentCategory: AgentCategory.ToolUse,
    inputFile: 'figures.tex',
    creationTimestamp: BASE_TIME - 14 * 60_000,
    executionId: 'abc124',
  },
  {
    name: 'review',
    label: 'reviewer-response - draft',
    modelLabel: 'Opus 4.7',
    agent: 'reviewer-response',
    agentCategory: AgentCategory.Workflow,
    inputFile: 'response.tex',
    creationTimestamp: BASE_TIME - 60 * 60_000,
    executionId: 'abc125',
  },
  {
    name: 'bib',
    label: 'bibliography sync',
    modelLabel: 'Sonnet 4.5',
    agent: 'research',
    agentCategory: AgentCategory.ToolUse,
    creationTimestamp: BASE_TIME - 3 * 60 * 60_000,
    executionId: 'abc126',
  },
];

const SAMPLE_TASK_GROUPS: TaskGroup[] = [
  {
    id: 'outline',
    name: 'Analyze manuscript structure',
    startTime: BASE_TIME + 1_000,
    endTime: BASE_TIME + 24_000,
    status: STREAM_STATUS.STOPPED,
  },
  {
    id: 'rewrite',
    name: 'Polish abstract and introduction',
    startTime: BASE_TIME + 25_000,
    status: STREAM_STATUS.RUNNING,
  },
];

const SAMPLE_MESSAGES: LogMessageData[] = [
  {
    id: 'm1',
    text: 'Polish the introduction; tighten the abstract.',
    level: LOG_LEVELS.INFO,
    timestamp: BASE_TIME + 1_000,
    messageType: MESSAGE_TYPES.USER_MESSAGE,
  },
  {
    id: 'm2',
    text: 'Skim outline, identify weak transitions, plan two passes.',
    level: LOG_LEVELS.INFO,
    timestamp: BASE_TIME + 7_000,
    groupId: 'outline',
    messageType: MESSAGE_TYPES.THINKING,
  },
  {
    id: 'm3',
    text: 'read_file manuscript.tex (1,824 lines)',
    level: LOG_LEVELS.INFO,
    timestamp: BASE_TIME + 14_000,
    groupId: 'outline',
    messageType: MESSAGE_TYPES.TOOL_USE,
  },
  {
    id: 'm4',
    text: 'Applied 4 edits to the opening paragraph.',
    level: LOG_LEVELS.INFO,
    timestamp: BASE_TIME + 33_000,
    groupId: 'rewrite',
    messageType: MESSAGE_TYPES.TOOL_USE,
  },
  {
    id: 'm5',
    text: 'Rewriting abstract for tone and length...',
    level: LOG_LEVELS.INFO,
    timestamp: BASE_TIME + 41_000,
    groupId: 'rewrite',
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
  },
];

const SAMPLE_STREAM_STATES: Map<string, StreamState> = new Map([
  [
    ACTIVE_STREAM_ID,
    createWorkflowStreamState({
      status: STREAM_STATUS.RUNNING,
      lastTimestamp: BASE_TIME + 41_000,
      conversationProgress: { conversationTurns: 2, toolCallCount: 4 },
      taskGroups: SAMPLE_TASK_GROUPS,
      files: SAMPLE_FILES,
    }),
  ],
  [
    'figures',
    createWorkflowStreamState({
      status: STREAM_STATUS.STOPPED,
      lastTimestamp: BASE_TIME - 10 * 60_000,
    }),
  ],
  [
    'review',
    createWorkflowStreamState({
      status: STREAM_STATUS.STOPPED,
      lastTimestamp: BASE_TIME - 52 * 60_000,
    }),
  ],
  [
    'bib',
    createWorkflowStreamState({
      status: STREAM_STATUS.STOPPED,
      lastTimestamp: BASE_TIME - 2 * 60 * 60_000,
    }),
  ],
]);

/**
 * Static layout mock of the ProgressBoard split. The fixture data is local,
 * but the header, log body, output files, and stream rail are the production
 * Lit components used by the real progress view.
 */
@customElement('texra-progress-board-layout-mock')
export class ProgressBoardLayoutMock extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .board {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(200px, 240px);
        min-height: 360px;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--wa-border-radius-m);
        background: var(--wa-color-surface-default, transparent);
        overflow: hidden;
      }

      @media (max-width: 720px) {
        .board {
          grid-template-columns: minmax(0, 1fr);
        }
      }

      .conversation {
        display: flex;
        flex-direction: column;
        min-width: 0;
        border-right: var(--border-thin) solid var(--color-border);
      }

      @media (max-width: 720px) {
        .conversation {
          border-right: none;
          border-bottom: var(--border-thin) solid var(--color-border);
        }
      }

      .log-body {
        min-height: 0;
        flex: 1;
      }

      task-group-list {
        height: 100%;
      }

      .files-block {
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--wa-space-2xs) var(--wa-space-s) var(--wa-space-xs);
        background: var(--wa-color-surface-raised, transparent);
      }
    `,
  ];

  @query('file-list') private fileListEl?: HTMLElement;

  override async firstUpdated(): Promise<void> {
    // Wait for the production <file-list> and its <wa-details> to upgrade
    // so the imperative open below targets a real shadow tree.
    await customElements.whenDefined('file-list');
    await customElements.whenDefined('wa-details');
    await Promise.resolve();
    const root = this.fileListEl?.shadowRoot;
    if (!root) return;
    for (const det of root.querySelectorAll('wa-details')) {
      (det as HTMLElement & { open: boolean }).open = true;
    }
  }

  override render(): TemplateResult {
    const activeStream = SAMPLE_STREAMS[0];
    return html`
      <div class="board">
        <div class="conversation">
          <stream-header
            .stream=${activeStream}
            .status=${STREAM_STATUS.RUNNING}
            .progress=${{
              conversationTurns: 2,
              toolCallCount: 4,
            }}
            .yoloActive=${true}
          ></stream-header>
          <div class="log-body">
            <task-group-list
              .groups=${SAMPLE_TASK_GROUPS}
              .messages=${SAMPLE_MESSAGES}
              .hasStreams=${true}
              .streamStatus=${STREAM_STATUS.RUNNING}
              .messageGeneration=${SAMPLE_MESSAGES.length}
            ></task-group-list>
          </div>
          <div class="files-block">
            <file-list
              .filesByRound=${SAMPLE_FILES}
              .failuresByRound=${{}}
              .showRoundHeaders=${false}
            ></file-list>
          </div>
        </div>
        <stream-tabs
          .streams=${SAMPLE_STREAMS}
          .activeStreamId=${ACTIVE_STREAM_ID}
          .filter=${'all'}
          .streamStates=${SAMPLE_STREAM_STATES}
          .pendingApprovalStreamIds=${new Set<string>()}
          .childStreamsByParent=${new Map<string, StreamTabInfo[]>()}
        ></stream-tabs>
      </div>
    `;
  }
}

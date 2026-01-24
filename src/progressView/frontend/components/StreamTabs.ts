// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports
import type { StreamTabInfo } from '@shared/schemas';
import { formatRelativeTime } from '../utils';

type StreamFilter = 'all' | 'workflow' | 'toolUse';
type StreamSort = 'time' | 'agent' | 'inputFile';

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  waiting: 'Waiting for follow-up',
  resuming: 'Resuming',
  ready: 'Ready',
};

const normalizeStatus = (status?: string) =>
  status && status !== 'ready' ? status : 'stopped';

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  @property({ type: Array }) streams: StreamTabInfo[] = [];
  @property({ type: String }) activeStream: string | null = null;
  @property({ type: String }) filter: StreamFilter = 'all';
  @property({ type: String }) sort: StreamSort = 'time';

  createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    return html`
      <div class="tabs">
        <div class="tabs-content">
          ${this.renderFilters()} ${this.renderSortButtons()}
          <div id="streamTabs">
            ${repeat(
              this.streams,
              (stream) => stream.name,
              (stream) => this.renderStream(stream),
            )}
            ${this.streams.length === 0
              ? html`<div class="tab-container">No streams available</div>`
              : null}
          </div>
        </div>
        <div class="clear-all-container">
          <vscode-button @click=${this.handleDeleteAll}>
            Delete all
          </vscode-button>
        </div>
      </div>
    `;
  }

  private renderFilters(): TemplateResult {
    return html`
      <div class="agent-filter-group" id="agentFilterButtons">
        ${this.renderFilterButton('all', 'All')}
        ${this.renderFilterButton('workflow', 'Workflow')}
        ${this.renderFilterButton('toolUse', 'Tool use')}
      </div>
    `;
  }

  private renderFilterButton(
    filter: StreamFilter,
    label: string,
  ): TemplateResult {
    return html`
      <vscode-radio
        .value=${filter}
        ?checked=${this.filter === filter}
        @change=${() => this.emitFilterChange(filter)}
      >
        ${label}
      </vscode-radio>
    `;
  }

  private renderSortButtons(): TemplateResult {
    return html`
      <div class="toolbar" id="sortButtons">
        ${this.renderSortButton('time', 'clock', 'Sort by time')}
        ${this.renderSortButton('agent', 'account', 'Sort by agent')}
        ${this.renderSortButton('inputFile', 'file', 'Sort by file')}
      </div>
    `;
  }

  private renderSortButton(
    sort: StreamSort,
    icon: string,
    title: string,
  ): TemplateResult {
    return html`
      <vscode-toolbar-button
        class="sort-btn ${this.sort === sort ? 'is-active' : ''}"
        data-sort=${sort}
        title=${title}
        icon=${icon}
        @click=${() => this.emitSortChange(sort)}
      ></vscode-toolbar-button>
    `;
  }

  private renderStream(stream: StreamTabInfo): TemplateResult {
    const isActive = stream.name === this.activeStream;
    const status = normalizeStatus(stream.status);
    const tooltip = this.buildTooltip(stream);
    const lastActive = stream.lastTimestamp
      ? formatRelativeTime(stream.lastTimestamp)
      : '';

    return html`
      <div class=${classMap({ 'tab-container': true, 'is-active': isActive })}>
        <button
          class="tab"
          data-stream=${stream.name}
          title=${tooltip}
          @click=${() => this.emitSelect(stream.name)}
        >
          <div class="tab-header">
            <span
              class=${classMap({
                'tab-status': true,
                [`is-${status}`]: true,
              })}
              data-status=${STATUS_LABELS[status] ?? status}
            ></span>
            <span class="tab-title">${stream.label || stream.name}</span>
          </div>
          <div class="tab-meta">
            <span class="model">${stream.model ?? ''}</span>
            <span class="last-active">${lastActive}</span>
            ${this.renderDecorators(stream)}
          </div>
        </button>
        <vscode-toolbar-button
          class="tab-delete"
          data-stream=${stream.name}
          title="Delete stream"
          icon="trash"
          @click=${(event: Event) => this.emitDelete(event, stream.name)}
        ></vscode-toolbar-button>
      </div>
    `;
  }

  private renderDecorators(stream: StreamTabInfo): TemplateResult {
    const agentIcon =
      stream.agentCategory === 'toolUse' ? 'tools' : 'symbol-method';

    return html`
      <i
        class="codicon codicon-${agentIcon} agent-category"
        title=${`Category: ${stream.agentCategory}`}
      ></i>
      ${stream.isRemote
        ? html`<i
            class="codicon codicon-cloud remote-agent"
            title="Remote agent"
          ></i>`
        : null}
      ${stream.hasMultipleOutputs
        ? html`<i
            class="codicon codicon-files multi-file"
            title="Multiple outputs"
          ></i>`
        : null}
    `;
  }

  private buildTooltip(stream: StreamTabInfo): string {
    const mainParts = [
      stream.label || stream.name,
      stream.model && `Model: ${stream.model}`,
      stream.inputFile && `Input: ${stream.inputFile}`,
    ].filter(Boolean);

    const mainLine = mainParts.join(' • ');

    if (stream.lastTimestamp) {
      const lastSeen = formatRelativeTime(stream.lastTimestamp);
      if (lastSeen && mainLine) return `${mainLine}\nLast activity ${lastSeen}`;
      if (lastSeen) return `Last activity ${lastSeen}`;
    }

    return mainLine;
  }

  private emitSelect(streamId: string) {
    this.dispatchEvent(
      new CustomEvent('stream-select', {
        detail: { streamId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitDelete(event: Event, streamId: string) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('stream-delete', {
        detail: { streamId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleDeleteAll() {
    this.dispatchEvent(
      new CustomEvent('stream-delete-all', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitFilterChange(filter: StreamFilter) {
    this.dispatchEvent(
      new CustomEvent('filter-change', {
        detail: { filter },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private emitSortChange(sort: StreamSort) {
    this.dispatchEvent(
      new CustomEvent('sort-change', {
        detail: { sort },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

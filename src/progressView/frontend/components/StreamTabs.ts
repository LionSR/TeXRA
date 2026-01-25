// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared utilities
import { formatRelativeTime } from '@shared/utils/string';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
} from '@shared/utils/icons';

// Local imports - progress view constants
import {
  ELEMENT_IDS,
  FILTER_BUTTONS,
  SORT_BUTTONS,
  STREAM_STATUS,
} from '../constants';
import { ProgressEvents } from '../events';
import type { StreamFilter, StreamSort } from '../store';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  @property({ type: Array }) streams: StreamTabInfo[] = [];
  @property({ type: String }) activeStreamId: string | null = null;
  @property({ type: String }) filter: StreamFilter = 'all';
  @property({ type: String }) sort: StreamSort = 'time';

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    return html`
      <div class="tabs">
        <div class="tabs-content">
          <div id=${ELEMENT_IDS.STREAM_TABS} @click=${this.handleTabClick}>
            ${repeat(
              this.streams,
              (stream) => stream.name,
              (stream) => this.renderTab(stream),
            )}
          </div>
          ${when(
            this.streams.length === 0,
            () => html`<div class="log-placeholder">No streams yet.</div>`,
          )}
        </div>
        <div class="clear-all-container">
          <vscode-radio-group
            id=${ELEMENT_IDS.AGENT_FILTER_CONTAINER}
            class="agent-filter-group"
            .value=${this.filter}
            @change=${this.handleFilterChange}
          >
            ${FILTER_BUTTONS.map(
              (btn) => html`
                <vscode-radio id=${btn.id} value=${btn.filter}>
                  ${btn.label}
                </vscode-radio>
              `,
            )}
          </vscode-radio-group>

          <vscode-toolbar-container
            id="sortButtons"
            @click=${this.handleSortClick}
          >
            ${SORT_BUTTONS.map(
              (btn) => html`
                <vscode-toolbar-button
                  id=${btn.id}
                  class="sort-btn"
                  icon=${btn.icon}
                  label=${btn.title}
                  title=${btn.title}
                  data-sort=${btn.sort}
                ></vscode-toolbar-button>
              `,
            )}
          </vscode-toolbar-container>

          <vscode-toolbar-button
            id=${ELEMENT_IDS.DELETE_ALL_BTN}
            icon="close-all"
            label="Clear all"
            @click=${this.handleDeleteAll}
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderTab(stream: StreamTabInfo): TemplateResult {
    const isActive = stream.name === this.activeStreamId;
    const tooltip = this.buildTooltip(stream);
    const status = this.normalizeStatus(stream.status);
    const statusLabel = status
      ? status.charAt(0).toUpperCase() + status.slice(1)
      : '';
    const agentDecorator = getAgentCategoryDecorator(stream.agentCategory);

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'stream-tab': true,
          'is-active': isActive,
        })}
      >
        <button class="tab" data-stream=${stream.name} title=${tooltip}>
          <div class="tab-header">
            <span
              class=${classMap({
                'tab-status': true,
                [`is-${status}`]: Boolean(status),
              })}
              data-status=${statusLabel}
            ></span>
            <span class="tab-title">${stream.label || stream.name}</span>
          </div>
          <div class="tab-meta">
            <span class="last-active"
              >${formatRelativeTime(stream.lastTimestamp ?? 0)}</span
            >
            <span class="model">${stream.model ?? ''}</span>
            <i
              class=${`codicon codicon-${agentDecorator.icon} agent-category`}
              title=${`Category: ${agentDecorator.label}`}
            ></i>
            ${when(
              stream.isRemote,
              () => html`
                <i
                  class=${`codicon codicon-${AGENT_DECORATORS.properties.remote.icon} remote-agent`}
                  title=${AGENT_DECORATORS.properties.remote.hint}
                ></i>
              `,
            )}
            ${when(
              stream.hasMultipleOutputs,
              () => html`
                <i
                  class=${`codicon codicon-${AGENT_DECORATORS.properties.multipleOutputs.icon} multi-file`}
                  title=${AGENT_DECORATORS.properties.multipleOutputs.hint}
                ></i>
              `,
            )}
          </div>
        </button>
        <vscode-toolbar-button
          class="tab-delete"
          icon="close"
          title="Delete stream"
          aria-label="Delete stream"
          data-stream=${stream.name}
        ></vscode-toolbar-button>
      </div>
    `;
  }

  private handleTabClick(event: MouseEvent) {
    const target = event.target as Element | null;
    if (!target) return;

    const tabButton = target.closest('.tab');
    if (tabButton instanceof HTMLElement && tabButton.dataset.stream) {
      this.dispatchEvent(
        ProgressEvents.streamSwitch({ streamId: tabButton.dataset.stream }),
      );
      return;
    }

    const deleteButton = target.closest('.tab-delete');
    if (deleteButton instanceof HTMLElement && deleteButton.dataset.stream) {
      this.dispatchEvent(
        ProgressEvents.streamDelete({ streamId: deleteButton.dataset.stream }),
      );
    }
  }

  private handleFilterChange(event: Event) {
    const group = event.currentTarget as
      | (HTMLElement & { value?: string })
      | null;
    const filter = group?.value as StreamFilter;
    if (!filter) return;

    this.dispatchEvent(ProgressEvents.filterChange({ filter }));
  }

  private handleSortClick(event: MouseEvent) {
    const target = event.target as Element | null;
    if (!target) return;

    const button = target.closest('.sort-btn') as HTMLElement | null;
    if (!button?.dataset.sort) return;

    this.dispatchEvent(
      ProgressEvents.sortChange({ sort: button.dataset.sort as StreamSort }),
    );
  }

  private handleDeleteAll() {
    this.dispatchEvent(ProgressEvents.deleteAll());
  }

  private buildTooltip(info: StreamTabInfo): string {
    const mainParts = [
      info.label,
      info.model && `Model: ${info.model}`,
      info.inputFile && `Input: ${info.inputFile}`,
    ].filter(Boolean);
    const mainLine = mainParts.join(' • ');
    if (!info.lastTimestamp) return mainLine;
    const lastSeen = formatRelativeTime(info.lastTimestamp);
    return lastSeen && mainLine
      ? `${mainLine}\nLast activity ${lastSeen}`
      : mainLine;
  }

  private normalizeStatus(status?: string): string {
    return !status || status === STREAM_STATUS.READY
      ? STREAM_STATUS.STOPPED
      : status;
  }
}

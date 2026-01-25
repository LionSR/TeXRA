// Third-party imports
import {
  LitElement,
  html,
  type TemplateResult,
  type PropertyValues,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - common helpers
import { formatRelativeTime } from '@common/modules/stringUtils.js';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
} from '@common/modules/iconConstants.js';
import {
  getRadioChangeValue,
  setRadioGroupValue,
} from '@common/modules/domUtils.js';

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

  firstUpdated(): void {
    this.syncFilterRadioGroup();
  }

  updated(changedProps: PropertyValues): void {
    if (changedProps.has('filter')) {
      this.syncFilterRadioGroup();
    }
  }

  private syncFilterRadioGroup(): void {
    const group = this.querySelector(
      `#${ELEMENT_IDS.AGENT_FILTER_CONTAINER}`,
    ) as HTMLElement | null;
    if (group) {
      setRadioGroupValue(group, this.filter);
    }
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
          ${this.streams.length === 0
            ? html`<div class="log-placeholder">No streams yet.</div>`
            : null}
        </div>
        <div class="clear-all-container">
          <vscode-radio-group
            id=${ELEMENT_IDS.AGENT_FILTER_CONTAINER}
            class="agent-filter-group"
            @change=${this.handleFilterChange}
          >
            ${FILTER_BUTTONS.map(
              (btn) => html`
                <vscode-radio
                  id=${btn.id}
                  value=${btn.filter}
                  ?checked=${this.filter === btn.filter}
                >
                  ${btn.label}
                </vscode-radio>
              `,
            )}
          </vscode-radio-group>

          <div id="sortButtons" @click=${this.handleSortClick}>
            ${SORT_BUTTONS.map(
              (btn) => html`
                <vscode-toolbar-button
                  id=${btn.id}
                  class="sort-btn"
                  icon=${btn.icon}
                  title=${btn.title}
                  data-sort=${btn.sort}
                ></vscode-toolbar-button>
              `,
            )}
          </div>

          <vscode-button
            id=${ELEMENT_IDS.DELETE_ALL_BTN}
            appearance="secondary"
            @click=${this.handleDeleteAll}
          >
            Clear all
          </vscode-button>
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
            ${stream.isRemote
              ? html`
                  <i
                    class=${`codicon codicon-${AGENT_DECORATORS.properties.remote.icon} remote-agent`}
                    title=${AGENT_DECORATORS.properties.remote.hint}
                  ></i>
                `
              : null}
            ${stream.hasMultipleOutputs
              ? html`
                  <i
                    class=${`codicon codicon-${AGENT_DECORATORS.properties.multipleOutputs.icon} multi-file`}
                    title=${AGENT_DECORATORS.properties.multipleOutputs.hint}
                  ></i>
                `
              : null}
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
    const group = event.currentTarget as HTMLElement | null;
    const filter = getRadioChangeValue(event, group) as StreamFilter;
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

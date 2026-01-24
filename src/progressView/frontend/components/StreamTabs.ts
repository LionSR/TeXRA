// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared icons
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
  getCodiconClass,
} from '@common/modules/iconConstants.js';
import { formatRelativeTime } from '@common/modules/stringUtils.js';

// Local imports - progress view
import { FILTER_BUTTONS, SORT_BUTTONS } from '../constants';
import type { StreamFilter, StreamSort } from '../store';
import type { StreamTabInfo } from '@shared/schemas';

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  @property({ type: Array }) streams: StreamTabInfo[] = [];
  @property({ type: String }) activeStream: string | null = null;
  @property({ type: String }) filter: StreamFilter = 'all';
  @property({ type: String }) sort: StreamSort = 'time';

  private handleFilterChange(event: Event) {
    const target = event.target as HTMLElement | null;
    const radio = target?.closest('vscode-radio');
    const value = radio?.getAttribute('value') || radio?.value;
    if (!value) return;
    this.dispatchEvent(
      new CustomEvent('filter-change', {
        detail: { filter: value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleSortClick(sort: StreamSort) {
    this.dispatchEvent(
      new CustomEvent('sort-change', {
        detail: { sort },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleStreamSelect(streamId: string) {
    this.dispatchEvent(
      new CustomEvent('stream-select', {
        detail: { streamId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleStreamDelete(streamId: string) {
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

  private buildTooltip(info: StreamTabInfo, includeLastActivity = false) {
    const mainParts = [
      info.label,
      info.model && `Model: ${info.model}`,
      info.inputFile && `Input: ${info.inputFile}`,
    ].filter(Boolean);

    const mainLine = mainParts.join(' • ');

    if (includeLastActivity && info.lastTimestamp) {
      const lastSeen = formatRelativeTime(info.lastTimestamp);
      if (lastSeen && mainLine) return `${mainLine}\nLast activity ${lastSeen}`;
      if (lastSeen) return `Last activity ${lastSeen}`;
    }

    return mainLine;
  }

  private renderStatus(info: StreamTabInfo) {
    const normalizedStatus =
      info.status && info.status !== 'ready' ? info.status : 'stopped';
    const statusClasses = {
      'tab-status': true,
      [`is-${normalizedStatus}`]: true,
    };

    return html`<span
      class=${classMap(statusClasses)}
      data-status=${normalizedStatus.charAt(0).toUpperCase() +
      normalizedStatus.slice(1)}
    ></span>`;
  }

  private renderDecorators(info: StreamTabInfo) {
    const category = getAgentCategoryDecorator(info.agentCategory);

    return html`
      <i
        class=${`${getCodiconClass(category.icon)} agent-category`}
        title=${`Category: ${category.label}`}
      ></i>
      ${when(
        info.isRemote,
        () => html`
          <i
            class=${`${getCodiconClass(
              AGENT_DECORATORS.properties.remote.icon,
            )} remote-agent`}
            title=${AGENT_DECORATORS.properties.remote.hint}
          ></i>
        `,
      )}
      ${when(
        info.hasMultipleOutputs,
        () => html`
          <i
            class=${`${getCodiconClass(
              AGENT_DECORATORS.properties.multipleOutputs.icon,
            )} multi-file`}
            title=${AGENT_DECORATORS.properties.multipleOutputs.hint}
          ></i>
        `,
      )}
    `;
  }

  private renderStream(info: StreamTabInfo) {
    const tooltip = this.buildTooltip(info);
    const isActive = info.name === this.activeStream;

    const containerClasses = {
      'tab-container': true,
      'stream-tab': true,
      'is-active': isActive,
    };

    return html`
      <div class=${classMap(containerClasses)} title=${tooltip}>
        <button
          class="tab"
          data-stream=${info.name}
          title=${tooltip}
          @click=${() => this.handleStreamSelect(info.name)}
        >
          <div class="tab-header">
            ${this.renderStatus(info)}
            <span class="tab-title">${info.label || info.name}</span>
          </div>
          <div class="tab-meta">
            <span class="model">${info.model ?? ''}</span>
            <span class="last-active"
              >${formatRelativeTime(info.lastTimestamp)}</span
            >
            ${this.renderDecorators(info)}
          </div>
        </button>
        <vscode-toolbar-button
          class="tab-delete"
          icon="close"
          title="Delete stream"
          @click=${() => this.handleStreamDelete(info.name)}
        ></vscode-toolbar-button>
      </div>
    `;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override render() {
    return html`
      <div class="tabs">
        <div class="agent-filter-group" id="agentFilterButtons">
          <vscode-radio-group @change=${this.handleFilterChange}>
            ${FILTER_BUTTONS.map(
              (btn) => html`
                <vscode-radio
                  value=${btn.filter}
                  ?checked=${this.filter === btn.filter}
                >
                  ${btn.label}
                </vscode-radio>
              `,
            )}
          </vscode-radio-group>
        </div>
        <div class="sort-buttons" id="sortButtons">
          ${SORT_BUTTONS.map(
            (btn) => html`
              <vscode-toolbar-button
                class="sort-btn"
                data-sort=${btn.sort}
                icon=${btn.icon}
                title=${btn.title}
                @click=${() => this.handleSortClick(btn.sort as StreamSort)}
              ></vscode-toolbar-button>
            `,
          )}
        </div>
        <div class="tabs-content" id="streamTabs">
          ${repeat(
            this.streams,
            (stream) => stream.name,
            (stream) => this.renderStream(stream),
          )}
          ${when(
            this.streams.length === 0,
            () => html`<div class="tab-container">No streams available</div>`,
          )}
        </div>
        <div class="clear-all-container">
          <vscode-button
            id="deleteAllBtn"
            appearance="secondary"
            @click=${this.handleDeleteAll}
          >
            Clear all
          </vscode-button>
        </div>
      </div>
    `;
  }
}

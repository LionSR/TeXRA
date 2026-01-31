// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared styles
// Note: Design tokens from tokens.css are inherited into Shadow DOM via :root
import { animationStyles, commonViewStyles } from '@shared/styles';
import { codiconIconClasses } from '@shared/styles/codiconStyles';
import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';

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
import { getComposedPathElement, getRadioValue } from '../utils';
import type { StreamFilter, StreamSort } from '../store';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

/** Format status string for display (capitalize first letter) */
function formatStatusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '';
}

@customElement('stream-tabs')
export class StreamTabs extends LitElement {
  static override styles = [
    animationStyles,
    commonViewStyles,
    codiconIconClasses,
    statusIndicatorStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      :host([hidden]) {
        display: none;
      }

      .tabs {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 200px;
        font-size: var(--font-size-sm);
        border-left: var(--border-thin) solid var(--color-border);
        height: 100%;
        overflow: visible;
        background-color: var(--background-color);
      }

      .tabs-content {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }

      .clear-all-container {
        flex-shrink: 0;
        border-top: var(--border-thin) solid var(--color-border);
        padding: var(--spacing-small);
      }

      .agent-filter-group {
        display: flex;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: var(--spacing-small);
        margin-bottom: var(--spacing-small);
      }

      .agent-filter-group vscode-radio {
        min-width: auto;
        flex: 0 0 auto;
      }

      .tab-container {
        display: flex;
        align-items: center;
        position: relative;
        width: 100%;
        gap: var(--spacing-tiny);
      }

      .tab {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: var(--spacing-small);
        cursor: pointer;
        border: none;
        background: none;
        color: var(--vscode-foreground);
        text-align: left;
        font-family: var(--font-family);
        min-width: 0;
        overflow-x: hidden;
      }

      .tab-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        width: 100%;
      }

      /* .tab-status styles from statusIndicatorStyles */
      .tab-header .tab-status {
        margin: 0;
      }

      .tab-title {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tab-meta {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
        opacity: var(--opacity-subtle);
        width: 100%;
      }

      .tab-meta .remote-agent,
      .tab-meta .agent-category,
      .tab-meta .multi-file {
        margin-left: var(--spacing-small);
      }

      .tab-delete {
        flex-shrink: 0;
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
        align-items: center;
        justify-content: center;
        width: var(--height-control);
        min-width: var(--height-control);
        height: var(--height-control);
        margin: 0 var(--spacing-small) 0 0;
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        transition:
          color 120ms ease,
          background-color 120ms ease;
      }

      .tab-container:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .tab-container.is-active {
        background-color: var(--vscode-list-activeSelectionBackground);
      }

      .tab-container.is-active .tab {
        color: var(--vscode-list-activeSelectionForeground);
      }

      .tab-delete::part(control) {
        padding: 0;
        border-radius: var(--border-radius-small);
        background-color: color-mix(
          in srgb,
          var(--vscode-icon-foreground, var(--vscode-foreground)) 10%,
          transparent
        );
      }

      .tab-delete:hover::part(control),
      .tab-delete:focus-within::part(control) {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .tab-delete:hover,
      .tab-delete:focus-within {
        color: var(--vscode-errorForeground);
      }

      .sort-btn.active::part(control) {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .log-placeholder {
        text-align: center;
        color: var(--color-text-secondary);
        padding: var(--spacing-large) var(--spacing-medium);
      }

      .log-placeholder a {
        color: var(--color-text-link);
        text-decoration: underline;
      }

      .log-placeholder a:hover {
        color: var(--color-text-link-active);
      }
    `,
  ];

  @property({ type: Array }) streams: StreamTabInfo[] = [];
  @property({ type: String }) activeStreamId: string | null = null;
  @property({ type: String }) filter: StreamFilter = 'all';
  @property({ type: String }) sort: StreamSort = 'time';

  override render(): TemplateResult {
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
            ${repeat(
              FILTER_BUTTONS,
              (btn) => btn.id,
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

          <vscode-toolbar-container
            id="sortButtons"
            @click=${this.handleSortClick}
          >
            ${repeat(
              SORT_BUTTONS,
              (btn) => btn.id,
              (btn) => html`
                <vscode-toolbar-button
                  id=${btn.id}
                  icon=${btn.icon}
                  label=${btn.title}
                  title=${btn.title}
                  data-sort=${btn.sort}
                  aria-pressed=${this.sort === btn.sort ? 'true' : 'false'}
                  class=${classMap({
                    'sort-btn': true,
                    active: this.sort === btn.sort,
                  })}
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
    const statusLabel = formatStatusLabel(status);
    const agentDecorator = getAgentCategoryDecorator(stream.agentCategory);

    return html`
      <div
        class=${classMap({
          'tab-container': true,
          'stream-tab': true,
          'is-active': isActive,
        })}
      >
        <button
          class="tab"
          data-stream=${stream.name}
          data-action="select"
          title=${tooltip}
        >
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
              >${stream.lastTimestamp
                ? formatRelativeTime(stream.lastTimestamp)
                : ''}</span
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
          data-action="delete"
        ></vscode-toolbar-button>
      </div>
    `;
  }

  private handleTabClick(event: MouseEvent): void {
    const actionElement = getComposedPathElement<HTMLElement>(
      event,
      '[data-stream][data-action]',
    );
    if (!(actionElement instanceof HTMLElement)) return;

    const { stream: streamId, action } = actionElement.dataset;
    if (!streamId) return;

    switch (action) {
      case 'select':
        this.dispatchEvent(ProgressEvents.streamSwitch({ streamId }));
        break;
      case 'delete':
        this.dispatchEvent(ProgressEvents.streamDelete({ streamId }));
        break;
      default:
        break;
    }
  }

  private handleFilterChange(event: Event): void {
    const filter = getRadioValue<StreamFilter>(event);
    if (!filter) return;
    this.dispatchEvent(ProgressEvents.filterChange({ filter }));
  }

  private handleSortClick(event: MouseEvent): void {
    const button = getComposedPathElement<HTMLElement>(event, '[data-sort]');
    if (!(button instanceof HTMLElement) || !button.dataset.sort) return;

    this.dispatchEvent(
      ProgressEvents.sortChange({ sort: button.dataset.sort as StreamSort }),
    );
  }

  private handleDeleteAll(): void {
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

  private normalizeStatus(status?: string | null): string {
    return status ?? STREAM_STATUS.READY;
  }
}

/** Shared browsing and selection for agents, skills, and plugins. Domain
 * actions and details remain with each page; search, rows, and keyboard
 * navigation have one implementation. */
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { commonViewStyles, designTokens } from '@ui/styles';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { settingsCatalogStyles } from './SettingsCatalog.styles';

export interface SettingsCatalogItem {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly searchText?: string;
  readonly badges?: TemplateResult;
  readonly control?: TemplateResult;
}

@customElement('settings-catalog')
export class SettingsCatalog extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsCatalogStyles,
  ];
  @property({ attribute: false }) items: readonly SettingsCatalogItem[] = [];
  @property() label = 'Items';
  @property() actionLabel = '';
  @property() placeholder = 'Search name or purpose';
  @property({ attribute: false }) selectedKey: string | null = null;
  @state() private query = '';
  @state() private group = 'all';

  private get visibleItems() {
    const query = this.query.trim().toLocaleLowerCase();
    const matches = this.items.filter(
      (item) =>
        (this.group === 'all' || item.group === this.group) &&
        `${item.name} ${item.description} ${item.searchText ?? ''}`
          .toLocaleLowerCase()
          .includes(query),
    );
    return [...Map.groupBy(matches, (item) => item.group).values()].flat();
  }

  private get activeKey(): string | null {
    const items = this.visibleItems;
    return (
      items.find((item) => item.key === this.selectedKey)?.key ??
      items[0]?.key ??
      null
    );
  }

  protected override updated(): void {
    if (
      this.group !== 'all' &&
      !this.items.some((item) => item.group === this.group)
    ) {
      this.group = 'all';
      return;
    }
    if (this.selectedKey !== this.activeKey) this.select(this.activeKey);
  }

  private select(key: string | null): void {
    this.dispatchEvent(
      new CustomEvent('catalog-select', {
        detail: key,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private navigate(event: KeyboardEvent): void {
    if (!(event.target as HTMLElement).closest('.catalog-row-select')) return;
    const items = this.visibleItems;
    const index = items.findIndex((item) => item.key === this.activeKey);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(index + 1, items.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (!items[next]) return;
    this.select(items[next].key);
    requestAnimationFrame(() =>
      this.shadowRoot
        ?.querySelector<HTMLElement>('.catalog-row-select[aria-current="true"]')
        ?.focus(),
    );
  }

  override render(): TemplateResult {
    const items = this.visibleItems;
    const groups = Map.groupBy(items, (item) => item.group);
    const sources = [...new Set(this.items.map((item) => item.group))];
    return html`
      <div class="catalog-toolbar">
        <wa-input
          class="catalog-search"
          label=${`Search ${this.label.toLocaleLowerCase()}`}
          placeholder=${this.placeholder}
          size="s"
          with-clear
          .value=${this.query}
          @input=${(event: Event) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
          >${waIcon('magnifying-glass', { slot: 'start' })}</wa-input
        >
        <wa-select
          label="Source"
          size="s"
          .value=${this.group}
          @change=${(event: Event) => {
            this.group = (event.target as HTMLSelectElement).value;
          }}
        >
          <wa-option value="all">All sources</wa-option>
          ${sources.map((group) => html`<wa-option value=${group}>${group}</wa-option>`)}
        </wa-select>
        <div class="catalog-actions"><slot name="actions"></slot></div>
      </div>
      <div class="catalog-panel">
        <div
          class="catalog-list"
          role="region"
          aria-label=${this.label}
          @keydown=${this.navigate}
        >
          ${[...groups].map(
            ([group, entries], index) => html`
              <div class="catalog-group" id=${`catalog-group-${index}`}>
                <span
                  >${group}
                  <span class="catalog-group-count"
                    >${entries.length}</span
                  ></span
                >
                <span>${this.actionLabel}</span>
              </div>
              <div role="list" aria-labelledby=${`catalog-group-${index}`}>
                ${repeat(
                  entries,
                  (item) => item.key,
                  (item) => html`
                    <div
                      class="catalog-row ${item.key === this.activeKey ? 'selected' : ''}"
                      role="listitem"
                    >
                      <button
                        class="catalog-row-select focus-ring-inset"
                        type="button"
                        aria-label=${item.name}
                        aria-current=${item.key === this.activeKey ? 'true' : nothing}
                        aria-controls="catalog-detail"
                        tabindex=${item.key === this.activeKey ? '0' : '-1'}
                        @click=${() => this.select(item.key)}
                      >
                        <span class="catalog-row-text"
                          ><bdi class="catalog-row-name" dir="auto"
                            >${item.name}</bdi
                          >
                          <span class="catalog-row-description" dir="auto"
                            >${item.description}</span
                          ></span
                        >
                        <span class="catalog-row-badges"
                          >${item.badges ?? nothing}</span
                        >
                      </button>
                      <div class="catalog-row-control">
                        ${item.control ?? nothing}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `,
          )}
          ${
            items.length === 0
              ? html`<p class="catalog-empty">
                  ${
                    this.items.length
                      ? `No matching ${this.label.toLocaleLowerCase()}. Try another search or source.`
                      : `No ${this.label.toLocaleLowerCase()} found.`
                  }
                </p>`
              : nothing
          }
        </div>
        <div class="catalog-detail" id="catalog-detail">
          ${this.activeKey ? html`<slot name="detail"></slot>` : html`<p class="catalog-empty">Select an item to inspect its details.</p>`}
        </div>
      </div>
      <div class="catalog-count" role="status">
        ${items.length} of ${this.items.length}
        ${this.label.toLocaleLowerCase()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-catalog': SettingsCatalog;
  }
}

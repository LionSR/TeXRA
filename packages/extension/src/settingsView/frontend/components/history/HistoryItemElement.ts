/** Single history entry with collapsible details and mark.js-driven search highlighting. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, queryAll } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import Mark from 'mark.js';

// Local imports - shared
import type { HistoryItem as HistoryItemData } from '@shared/schemas';
import { badgeStyles, commonViewStyles, designTokens } from '@shared/styles';
import { AGENT_CATEGORY } from '@shared/schemas/agent';
import { markdownStyles } from '@shared/styles/markdownStyles';
import { getAgentCategoryDecorator } from '@shared/utils/icons';
import { getLightweightMd } from '@shared/highlighting/lightweightMd';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { metaStripStyles, renderDotMeta } from '@shared/wa/metaStrip';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - history view styles
import { historyStyles } from '@shared/styles/historyStyles';

// Local imports - history view events
import { HistoryViewEvents } from './events';

type ConfigValue = string | number | boolean | string[] | null | undefined;

@customElement('history-item')
export class HistoryItemElement extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    ...badgeStyles,
    historyStyles,
    metaStripStyles,
    markdownStyles,
  ];

  @property({ attribute: false }) item?: HistoryItemData;
  @property({ attribute: false }) open = false;
  /** Local index of the mark to highlight as current, or null if none in this item */
  @property({ attribute: false }) highlightedMatchIndex: number | null = null;

  private markInstance: Mark | null = null;
  private previousHighlightedIndex: number | null = null;
  private previousItemId: string | undefined = undefined;

  /** Cached markdown render to avoid re-parsing on every Lit update cycle. */
  private cachedInstructionSource: string | null = null;
  private cachedInstructionHtml = '';

  @queryAll('mark')
  private markElements!: HTMLElement[];

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearMarkInstance();
  }

  protected override willUpdate(
    changedProperties: Map<PropertyKey, unknown>,
  ): void {
    // Clear mark instance when item changes to avoid stale highlights
    if (changedProperties.has('item')) {
      const newItemId = this.item?.id;
      if (this.previousItemId !== newItemId) {
        this.clearMarkInstance();
        this.previousItemId = newItemId;
      }
    }
  }

  private clearMarkInstance(): void {
    if (this.markInstance) {
      this.markInstance.unmark();
      this.markInstance = null;
    }
    this.previousHighlightedIndex = null;
  }

  private renderMarkdown(text: string): string {
    if (text !== this.cachedInstructionSource) {
      this.cachedInstructionSource = text;
      this.cachedInstructionHtml = getLightweightMd().render(text);
    }
    return this.cachedInstructionHtml;
  }

  private handleAction(action: string): void {
    if (!this.item) return;
    this.dispatchEvent(
      HistoryViewEvents.historyAction({ action, historyId: this.item.id }),
    );
  }

  private handleActionClick(event: MouseEvent): void {
    const action = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-action]',
    )?.dataset.action;
    if (action) {
      this.handleAction(action);
    }
  }

  private dispatchToggle(event: Event, open: boolean): void {
    if (!this.item) return;
    // Ignore wa-show/wa-hide bubbling up from any nested wa-details.
    if (event.target !== event.currentTarget) return;
    this.dispatchEvent(
      HistoryViewEvents.toggleItem({ historyId: this.item.id, open }),
    );
  }

  /**
   * React to highlightedMatchIndex changes - apply current match attribute.
   * Uses direct DOM manipulation since mark.js creates marks dynamically.
   */
  protected override updated(): void {
    if (this.highlightedMatchIndex === this.previousHighlightedIndex) {
      return;
    }

    const marks = this.getMarks();
    const prevMark =
      this.previousHighlightedIndex !== null
        ? marks[this.previousHighlightedIndex]
        : null;
    const currMark =
      this.highlightedMatchIndex !== null
        ? marks[this.highlightedMatchIndex]
        : null;

    prevMark?.removeAttribute('data-current');

    if (currMark) {
      currMark.setAttribute('data-current', 'true');
      currMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    this.previousHighlightedIndex = this.highlightedMatchIndex;
  }

  private ensureMarkInstance(): void {
    if (!this.markInstance) {
      this.markInstance = new Mark(this.renderRoot as DocumentFragment);
    }
  }

  async applySearch(term: string): Promise<number> {
    this.ensureMarkInstance();
    return new Promise((resolve) => {
      this.markInstance?.unmark({
        done: () => {
          if (!term) {
            resolve(0);
            return;
          }
          let count = 0;
          this.markInstance?.mark(term, {
            each: () => {
              count += 1;
            },
            done: () => resolve(count),
          });
        },
      });
    });
  }

  getMarks(): HTMLElement[] {
    return this.markElements ?? [];
  }

  private renderValue(value: ConfigValue): TemplateResult {
    if (Array.isArray(value)) {
      return html`${value.join(', ')}`;
    }
    if (typeof value === 'boolean') {
      return html`${value ? 'Yes' : 'No'}`;
    }
    return html`${value ?? ''}`;
  }

  private hasValue(value: ConfigValue): boolean {
    if (value == null) return false;
    return !Array.isArray(value) || value.length > 0;
  }

  private renderConfigSection(
    label: string | TemplateResult,
    entries: Array<[string, ConfigValue]>,
  ): TemplateResult | null {
    const filtered = entries.filter(([, value]) => this.hasValue(value));
    if (!filtered.length) return null;

    return html`
      <span class="history-label">${label}:</span>
      <div class="history-value config-section">
        ${filtered.map(
          ([key, value]) => html`
            <div class="config-item">
              <span class="config-key">${key}:</span>
              <span class="config-value">${this.renderValue(value)}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.item) {
      return nothing;
    }

    const config = this.item.agentConfig;
    const timestamp = new Date(this.item.timestamp).toLocaleString();
    const isToolUse = config.agentCategory === AGENT_CATEGORY.TOOL_USE;
    const categoryVariant: 'warning' | 'brand' = isToolUse
      ? 'warning'
      : 'brand';
    const decorator = getAgentCategoryDecorator(config.agentCategory);
    const instructionText = config.instruction?.trim()
      ? config.instruction
      : null;
    const descriptionText = this.item.description?.trim() || null;

    const extraDetails: Array<TemplateResult> = [];

    // File fields only exist on workflow configs (discriminated union)
    if (config.agentCategory === AGENT_CATEGORY.WORKFLOW) {
      const contextSection = this.renderConfigSection('Context', [
        ['ContextFiles', config.contextFiles],
      ]);
      if (contextSection) extraDetails.push(contextSection);

      const outputSection = this.renderConfigSection('Output Files', [
        ['Files', config.outputFiles],
      ]);
      if (outputSection) extraDetails.push(outputSection);

      if (config.toolConfig) {
        const toolEntries = (
          Object.entries(config.toolConfig) as Array<[string, ConfigValue]>
        ).filter(([, value]) => this.hasValue(value));
        const toolSection = this.renderConfigSection(
          html`<wa-icon library="texra" name="tools"></wa-icon> Config`,
          toolEntries,
        );
        if (toolSection) extraDetails.push(toolSection);
      }
    }

    const titleText = instructionText ?? descriptionText ?? '(no instruction)';

    const metaParts: Array<string | TemplateResult> = [
      timestamp,
      html`<wa-tag
        class="agent-category-badge"
        variant=${categoryVariant}
        size="small"
      >
        ${decorator.icon
          ? html`<wa-icon library="texra" name=${decorator.icon}></wa-icon>`
          : nothing}
        ${decorator.label}
      </wa-tag>`,
      `Agent: ${config.agent ?? 'Unknown'}`,
      `Model: ${config.model ?? 'Unknown'}`,
    ];
    if (config.agentCategory === AGENT_CATEGORY.WORKFLOW) {
      if (config.inputFiles?.length) {
        metaParts.push(`Inputs: ${config.inputFiles.join(', ')}`);
      }
      if (config.mediaFiles?.length) {
        metaParts.push(`Media: ${config.mediaFiles.join(', ')}`);
      }
    }

    return html`
      <div class="list-item history-item">
        <div class="list-item-header">
          <div class="history-title">
            ${instructionText
              ? html`<div class="markdown-content">
                  ${unsafeHTML(this.renderMarkdown(titleText))}
                </div>`
              : html`<span>${titleText}</span>`}
          </div>
          <div
            class="history-actions action-button-group"
            @click=${this.handleActionClick}
          >
            ${renderIconActionButton({
              icon: 'trash',
              label: 'Delete',
              action: 'delete',
            })}
            ${renderIconActionButton({
              icon: 'reply',
              label: 'Setup',
              action: 'restore',
            })}
            ${renderIconActionButton({
              icon: 'rotate-right',
              label: 'Rerun',
              action: 'rerun',
            })}
            ${isToolUse
              ? html`
                  ${renderIconActionButton({
                    icon: 'file-lines',
                    label: 'Export Markdown',
                    title: 'Export as Markdown',
                    action: 'export-md',
                  })}
                  ${renderIconActionButton({
                    icon: 'file-pdf',
                    label: 'Export PDF',
                    title: 'Export as LaTeX/PDF',
                    action: 'export-tex',
                  })}
                `
              : nothing}
          </div>
        </div>
        <div class="text-secondary meta-strip">${renderDotMeta(metaParts)}</div>
        ${extraDetails.length
          ? html`
              <wa-details
                class="collapsible"
                summary="More details"
                ?open=${this.open}
                @wa-show=${(e: Event) => this.dispatchToggle(e, true)}
                @wa-hide=${(e: Event) => this.dispatchToggle(e, false)}
                data-id=${this.item.id}
              >
                <div class="history-details extra-details">${extraDetails}</div>
              </wa-details>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-item': HistoryItemElement;
  }
}

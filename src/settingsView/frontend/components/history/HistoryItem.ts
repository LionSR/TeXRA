/**
 * HistoryItem component - displays a single history entry with collapsible details.
 * Uses mark.js for search highlighting.
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, queryAll } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import Mark from 'mark.js';

// Local imports - shared styles
import {
  badgeStyles,
  codiconStyles,
  commonViewStyles,
  designTokens,
} from '@shared/styles';
import { getAgentCategoryDecorator } from '@shared/utils/icons';

// Local imports - history view styles
import { historyViewStyles } from './styles';

// Local imports - history view events
import { HistoryViewEvents } from './events';

// Local imports - shared schemas
import type { HistoryItem as HistoryItemData } from '@shared/schemas';

type ConfigValue = string | number | boolean | string[] | null | undefined;

@customElement('history-item')
export class HistoryItem extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    ...badgeStyles,
    historyViewStyles,
  ];

  @property({ attribute: false }) item?: HistoryItemData;
  @property({ type: Boolean }) open = false;
  /** Local index of the mark to highlight as current, or null if none in this item */
  @property({ type: Number }) highlightedMatchIndex: number | null = null;

  private markInstance: Mark | null = null;
  private previousHighlightedIndex: number | null = null;
  private previousItemId: string | undefined = undefined;

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

  private handleAction(action: string): void {
    if (!this.item) return;
    this.dispatchEvent(
      HistoryViewEvents.historyAction({ action, historyId: this.item.id }),
    );
  }

  private handleToggle(event: CustomEvent<{ open?: boolean }>): void {
    if (!this.item) return;
    const open = event.detail?.open ?? this.open;
    this.dispatchEvent(
      HistoryViewEvents.toggleItem({
        historyId: this.item.id,
        open: Boolean(open),
      }),
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
    if (value === null || value === undefined) return false;
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
    const isToolUse = config.agentCategory === 'toolUse';
    const categoryClass = isToolUse ? 'category-tool-use' : 'category-workflow';
    const decorator = getAgentCategoryDecorator(
      isToolUse ? 'toolUse' : 'workflow',
    );
    const instructionText = config.instruction?.trim()
      ? config.instruction
      : null;

    const extraDetails: Array<TemplateResult> = [];

    const referenceSection = this.renderConfigSection('Reference', [
      ['ReferenceFile', config.referenceFile],
      ['ReferenceFiles', config.referenceFiles],
    ]);
    if (referenceSection) extraDetails.push(referenceSection);

    const auxiliarySection = this.renderConfigSection('Auxiliary', [
      ['AuxiliaryFile', config.auxiliaryFile],
      ['AuxiliaryFiles', config.auxiliaryFiles],
    ]);
    if (auxiliarySection) extraDetails.push(auxiliarySection);

    const outputSection = this.renderConfigSection('Output Files', [
      ['Files', config.outputFiles],
    ]);
    if (outputSection) extraDetails.push(outputSection);

    if (config.toolConfig && !isToolUse) {
      const toolEntries = (
        Object.entries(config.toolConfig) as Array<[string, ConfigValue]>
      ).filter(([, value]) => this.hasValue(value));
      const toolSection = this.renderConfigSection(
        html`<i class="codicon codicon-tools"></i> Config`,
        toolEntries,
      );
      if (toolSection) extraDetails.push(toolSection);
    }

    return html`
      <div class="list-item history-item">
        <div class="list-item-header">
          <div class="text-secondary history-timestamp">${timestamp}</div>
          <vscode-toolbar-container class="history-actions">
            <vscode-toolbar-button
              icon="trash"
              label="Delete"
              title="Delete"
              @click=${() => this.handleAction('delete')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              icon="reply"
              label="Restore"
              title="Restore"
              @click=${() => this.handleAction('restore')}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              icon="debug-rerun"
              label="Rerun"
              title="Rerun"
              @click=${() => this.handleAction('rerun')}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <div class="history-details basic-details">
          <span class="history-label">Category:</span>
          <span class="history-value">
            <span class="badge agent-category-badge ${categoryClass}">
              ${decorator.icon
                ? html`<i
                    class=${ifDefined(`codicon codicon-${decorator.icon}`)}
                  ></i>`
                : nothing}
              ${decorator.label}
            </span>
          </span>
          <span class="history-label">Agent:</span>
          <span class="history-value">${config.agent ?? 'Unknown'}</span>
          <span class="history-label">Model:</span>
          <span class="history-value">${config.model ?? 'Unknown'}</span>
          <span class="history-label">Instruction:</span>
          <span class="history-value">
            ${instructionText
              ? instructionText
              : html`<em class="history-none">Not set</em>`}
          </span>
          <span class="history-label">InputFile:</span>
          <span class="history-value">
            ${config.inputFile ? config.inputFile : 'None'}
          </span>
          ${config.inputFiles?.length
            ? html`
                <span class="history-label">InputFiles:</span>
                <span class="history-value"
                  >${config.inputFiles.join(', ')}</span
                >
              `
            : nothing}
          ${config.mediaFile
            ? html`
                <span class="history-label">MediaFile:</span>
                <span class="history-value">${config.mediaFile}</span>
              `
            : nothing}
          ${config.mediaFiles?.length
            ? html`
                <span class="history-label">MediaFiles:</span>
                <span class="history-value"
                  >${config.mediaFiles.join(', ')}</span
                >
              `
            : nothing}
        </div>
        ${extraDetails.length
          ? html`
              <vscode-collapsible
                class="collapsible"
                heading="More details"
                ?open=${this.open}
                @vsc-collapsible-toggle=${this.handleToggle}
                data-id=${this.item.id}
              >
                <div class="history-details extra-details">${extraDetails}</div>
              </vscode-collapsible>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-item': HistoryItem;
  }
}

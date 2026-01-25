// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import { getAgentCategoryDecorator } from '@shared/utils/icons';

// Local imports - history view styles
import { historyViewStyles } from '../styles';

// Local imports - history view events
import { HistoryViewEvents } from '../events';

// Local imports - shared schemas
import type { HistoryItem as HistoryItemData } from '@shared/schemas';

type MarkInstance = {
  mark: (
    term: string,
    options: { each?: () => void; done?: () => void },
  ) => void;
  unmark: (options: { done?: () => void }) => void;
};

type MarkConstructor = new (
  context: Element | DocumentFragment,
) => MarkInstance;

declare const Mark: MarkConstructor;

type ConfigValue = string | number | boolean | string[] | null | undefined;

@customElement('history-item')
export class HistoryItem extends LitElement {
  static styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    historyViewStyles,
  ];

  @property({ attribute: false }) item?: HistoryItemData;
  @property({ type: Boolean }) open = false;

  private markInstance: MarkInstance | null = null;

  private handleAction = (action: string): void => {
    if (!this.item) return;
    this.dispatchEvent(
      HistoryViewEvents.historyAction({ action, historyId: this.item.id }),
    );
  };

  private handleToggle = (event: Event): void => {
    if (!this.item) return;
    const target = event.target as HTMLElement & { open?: boolean };
    this.dispatchEvent(
      HistoryViewEvents.toggleItem({
        historyId: this.item.id,
        open: Boolean(target.open),
      }),
    );
  };

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
    return [...this.renderRoot.querySelectorAll('mark')];
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

  private renderConfigSection(
    label: string,
    entries: Array<[string, ConfigValue]>,
  ): TemplateResult | null {
    const filtered = entries.filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    });
    if (!filtered.length) return null;

    return html`
      <span class="history-label">${label}:</span>
      <div class="history-value config-section">
        ${filtered.map(
          ([key, value]) => html`
            <div class="config-item">
              <span class="config-key">${key}:</span>
              <span>${this.renderValue(value)}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  render(): TemplateResult {
    if (!this.item) {
      return html``;
    }

    const config = this.item.agentConfig;
    const timestamp = new Date(this.item.timestamp).toLocaleString();
    const categoryName =
      config.agentCategory === 'toolUse' ? 'toolUse' : 'workflow';
    const categoryClass =
      config.agentCategory === 'toolUse'
        ? 'category-tool-use'
        : 'category-workflow';
    const decorator = getAgentCategoryDecorator(categoryName);
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

    if (config.toolConfig && config.agentCategory !== 'toolUse') {
      const toolEntries = Object.entries(config.toolConfig).filter(
        ([, value]) => value !== null && value !== undefined,
      );
      if (toolEntries.length > 0) {
        extraDetails.push(html`
          <span class="history-label">
            <i class="codicon codicon-tools"></i> Config:
          </span>
          <div class="history-value config-section">
            ${toolEntries.map(([key, value]) => {
              return html`
                <div class="config-item">
                  <span class="config-key">${key}:</span>
                  <span>${this.renderValue(value as ConfigValue)}</span>
                </div>
              `;
            })}
          </div>
        `);
      }
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
            <span class="badge ${categoryClass}">
              ${decorator.icon
                ? html`<i
                    class=${ifDefined(`codicon codicon-${decorator.icon}`)}
                  ></i>`
                : ''}
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
            : ''}
          ${config.mediaFile
            ? html`
                <span class="history-label">MediaFile:</span>
                <span class="history-value">${config.mediaFile}</span>
              `
            : ''}
          ${config.mediaFiles?.length
            ? html`
                <span class="history-label">MediaFiles:</span>
                <span class="history-value"
                  >${config.mediaFiles.join(', ')}</span
                >
              `
            : ''}
        </div>
        ${extraDetails.length
          ? html`
              <vscode-collapsible
                class="collapsible"
                heading="More details"
                ?open=${this.open}
                @toggle=${this.handleToggle}
                data-id=${this.item.id}
              >
                <div class="history-details extra-details">${extraDetails}</div>
              </vscode-collapsible>
            `
          : ''}
      </div>
    `;
  }
}

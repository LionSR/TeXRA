/** Single history entry with collapsible details and mark.js-driven search highlighting. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, queryAll } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { UnsupportedCommandsMixin } from '@shared/wa/unsupportedCommandsMixin';
import Mark from 'mark.js';

// Local imports - shared
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { HistoryItem as HistoryItemData } from '@shared/schemas';
import { commonViewStyles, designTokens, historyStyles } from '@shared/styles';
import { getLightweightMd } from '@shared/highlighting/lightweightMd';
import { markdownStyles } from '@shared/styles/markdownStyles';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import {
  renderIconActionButton,
  type IconActionButtonOptions,
} from '@shared/wa/actionButtons';
import { metaStripStyles, renderDotMeta } from '@shared/wa/metaStrip';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - history view styles
// `searchHighlightStyles` is not part of the '@shared/styles' barrel (see its header).
import { searchHighlightStyles } from '@shared/styles/historyStyles';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

// Local imports - history view events
import { HistoryViewEvents } from './events';
import {
  getHistoryItemPresentation,
  hasHistoryConfigValue,
  type HistoryConfigValue,
} from './historyItemPresentation';

const LONG_INSTRUCTION_CHARS = 400;

/** Per-item action buttons, in render order. */
const HISTORY_ACTIONS: ReadonlyArray<{
  readonly button: IconActionButtonOptions & { readonly action: string };
  /** Settings-view command this action posts, carrying this item's historyId. */
  readonly command: string;
  /**
   * Hidden when the host's registry declares `command` unsupported, instead of
   * leaving a control visible that can only produce an unavailable-command
   * toast. Delete renders on every host.
   */
  readonly hideWhenUnsupported?: boolean;
  /** Rendered only for tool-use runs. */
  readonly toolUseOnly?: boolean;
}> = [
  {
    button: {
      id: 'history-delete-button',
      icon: 'trash',
      label: 'Delete',
      tooltip: 'Delete this history item',
      action: 'delete',
    },
    command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
  },
  {
    button: {
      id: 'history-setup-button',
      icon: 'reply',
      label: 'Setup',
      tooltip: "Restore this run's setup",
      action: 'restore',
    },
    command: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
    hideWhenUnsupported: true,
  },
  {
    button: {
      id: 'history-rerun-button',
      icon: 'rotate-right',
      label: 'Rerun',
      tooltip: 'Rerun this task',
      action: 'rerun',
    },
    command: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
    hideWhenUnsupported: true,
  },
  {
    button: {
      id: 'history-export-md-button',
      icon: 'file-lines',
      label: 'Export Markdown',
      tooltip: 'Export as Markdown',
      action: 'export-md',
    },
    command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
    hideWhenUnsupported: true,
    toolUseOnly: true,
  },
  {
    button: {
      id: 'history-export-pdf-button',
      icon: 'file-pdf',
      label: 'Export PDF',
      tooltip: 'Export as PDF (via LaTeX)',
      action: 'export-tex',
    },
    command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
    hideWhenUnsupported: true,
    toolUseOnly: true,
  },
  {
    button: {
      id: 'history-export-html-button',
      icon: 'globe',
      label: 'Export HTML',
      tooltip: 'Export as shareable HTML webpage',
      action: 'export-html',
    },
    command: SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML,
    hideWhenUnsupported: true,
    toolUseOnly: true,
  },
];

/** Clicked `data-action` → the command it posts. */
const HISTORY_ACTION_COMMANDS: ReadonlyMap<string, string> = new Map(
  HISTORY_ACTIONS.map((entry) => [entry.button.action, entry.command]),
);

@customElement('history-item')
export class HistoryItemElement extends UnsupportedCommandsMixin(LitElement) {
  static override styles = [
    designTokens,
    commonViewStyles,
    searchHighlightStyles,
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

  /** Cached markdown renders to avoid re-parsing on every Lit update cycle. */
  private readonly cachedMarkdown = new Map<string, string>();

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
    let rendered = this.cachedMarkdown.get(text);
    if (rendered == null) {
      rendered = getLightweightMd().render(text);
      this.cachedMarkdown.set(text, rendered);
    }
    return rendered;
  }

  private renderMarkdownValue(value: string): TemplateResult {
    return html`<span class="markdown-content"
      >${unsafeHTML(this.renderMarkdown(value))}</span
    >`;
  }

  private handleAction(action: string): void {
    if (!this.item) return;
    const command = HISTORY_ACTION_COMMANDS.get(action);
    if (!command) return;
    postMessage(command, { historyId: this.item.id });
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

  private renderValue(value: HistoryConfigValue): TemplateResult {
    if (Array.isArray(value)) {
      return this.renderMarkdownValue(value.join(', '));
    }
    if (typeof value === 'boolean') {
      return html`${value ? 'Yes' : 'No'}`;
    }
    if (typeof value === 'string') {
      return this.renderMarkdownValue(value);
    }
    return html`${value ?? ''}`;
  }

  private renderInstructionBlock(
    instructionText: string | null,
    titleText: string,
  ): TemplateResult {
    const body = instructionText
      ? html`<div class="markdown-content">
          ${unsafeHTML(this.renderMarkdown(titleText))}
        </div>`
      : html`<span>${titleText}</span>`;

    const isLong =
      !!instructionText && instructionText.length > LONG_INSTRUCTION_CHARS;

    if (!isLong || !this.item) {
      return html`<div class="history-title">${body}</div>`;
    }

    return html`
      <wa-details
        class="collapsible-quiet instruction-collapsible"
        summary="Show full instructions"
        ?open=${this.open}
        @wa-show=${(e: Event) => this.dispatchToggle(e, true)}
        @wa-hide=${(e: Event) => this.dispatchToggle(e, false)}
        data-id=${this.item.id}
      >
        <div class="history-title">${body}</div>
      </wa-details>
    `;
  }

  private renderConfigSection(
    label: string | TemplateResult,
    entries: Array<[string, HistoryConfigValue]>,
  ): TemplateResult | null {
    const filtered = entries.filter(([, value]) =>
      hasHistoryConfigValue(value),
    );
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

    const presentation = getHistoryItemPresentation(this.item);
    const categoryVariant: 'warning' | 'brand' = presentation.isToolUse
      ? 'warning'
      : 'brand';

    // renderConfigSection filters empty entries and returns null when none remain.
    const extraDetails = presentation.sections
      .map((section) =>
        this.renderConfigSection(
          section.icon
            ? html`${waIcon(section.icon)} ${section.label}`
            : section.label,
          section.entries,
        ),
      )
      .filter((section) => section !== null);

    const metaParts: Array<string | TemplateResult> = [
      presentation.timestamp,
      html`<wa-tag variant=${categoryVariant} size="s">
        ${
          presentation.decorator.icon
            ? waIcon(presentation.decorator.icon)
            : nothing
        }
        ${presentation.decorator.label}
      </wa-tag>`,
      html`<wa-tag variant=${presentation.status.variant} size="s">
        ${presentation.status.label}
      </wa-tag>`,
      `Agent: ${presentation.agent}`,
      `Model: ${presentation.model}`,
    ];
    if (presentation.inputFiles.length > 0) {
      metaParts.push(`Inputs: ${presentation.inputFiles.join(', ')}`);
    }
    if (presentation.mediaFiles.length > 0) {
      metaParts.push(`Media: ${presentation.mediaFiles.join(', ')}`);
    }

    return html`
      <div class="list-item history-item">
        <div class="list-item-header">
          <div class="text-secondary meta-strip">
            ${renderDotMeta(metaParts)}
          </div>
          <div
            class="history-actions action-button-group"
            @click=${this.handleActionClick}
          >
            ${HISTORY_ACTIONS.filter(
              (entry) =>
                (!entry.toolUseOnly || presentation.isToolUse) &&
                (!entry.hideWhenUnsupported ||
                  !isKnownUnsupported(this.unsupportedCommands, entry.command)),
            ).map((entry) =>
              renderIconActionButton({
                ...entry.button,
                label: `${entry.button.label}: ${truncateWithEllipsis(presentation.title, LONG_INSTRUCTION_CHARS)}`,
              }),
            )}
          </div>
        </div>
        ${this.renderInstructionBlock(
          presentation.instruction,
          presentation.title,
        )}
        ${
          presentation.summary
            ? html`<div class="history-description">
                ${presentation.summary}
              </div>`
            : nothing
        }
        ${
          extraDetails.length
            ? html`<div class="history-details extra-details">
                ${extraDetails}
              </div>`
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-item': HistoryItemElement;
  }
}

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@shared/styles';
import {
  detectBrowserPlatform,
  formatDesktopAccelerator,
} from '@shared/commands/accelerators';
import {
  getDesktopShortcutService,
  keyboardEventToAccelerator,
  type DesktopShortcutEntry,
} from '@shared/commands/shortcutPreferences';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@shared/wa/actionButtons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';
import { waIcon } from '@shared/wa/webAwesomeIcons';

@customElement('shortcuts-tab')
export class ShortcutsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsBannerStyles,
    css`
      :host {
        display: block;
      }

      .shortcuts-feedback {
        min-height: 1.4em;
        margin: 0 0 var(--wa-space-xs);
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
      }

      .shortcuts-search {
        width: min(100%, 28rem);
        margin-block-end: var(--wa-space-xs);
      }

      .shortcuts-command {
        font-family: var(--wa-font-family-mono);
        font-size: var(--font-size-xs);
        color: var(--wa-color-text-quiet);
      }

      .shortcuts-control {
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .shortcut-recorder {
        min-width: 9rem;
      }

      .shortcut-recorder[data-recording='true']::part(base) {
        border-color: var(--wa-color-focus);
        box-shadow: 0 0 0 var(--focus-ring-width)
          color-mix(in srgb, var(--wa-color-focus) 26%, transparent);
      }

      .shortcuts-feedback[data-error='true'] {
        color: var(--color-error);
      }

      @container settings (max-width: 520px) {
        .shortcuts-control {
          justify-content: flex-start;
        }
      }
    `,
  ];

  @state() private entries: readonly DesktopShortcutEntry[] = [];
  @state() private recordingId: string | undefined;
  @state() private query = '';
  @state() private feedback = '';
  @state() private feedbackIsError = false;

  private unsubscribe: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = getDesktopShortcutService()?.subscribe((entries) => {
      this.entries = entries;
    });
  }

  override disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    super.disconnectedCallback();
  }

  private handleSearch(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.query = input?.value ?? '';
  }

  private startRecording(id: string): void {
    this.recordingId = id;
    this.feedback =
      'Press a shortcut. Use Escape to cancel or Delete to clear.';
    this.feedbackIsError = false;
  }

  private captureShortcut(
    event: KeyboardEvent,
    entry: DesktopShortcutEntry,
  ): void {
    if (this.recordingId !== entry.id) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.recordingId = undefined;
      this.feedback = '';
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      this.updateShortcut(entry.id, undefined);
      return;
    }

    const accelerator = keyboardEventToAccelerator(event, detectBrowserPlatform());
    if (!accelerator) {
      this.feedback =
        'Include Command, Control, or Alt (or use a function key).';
      this.feedbackIsError = true;
      return;
    }
    const conflict = this.entries.find(
      (candidate) =>
        candidate.id !== entry.id &&
        candidate.accelerator?.toLowerCase() === accelerator.toLowerCase(),
    );
    if (conflict) {
      this.feedback = `"${accelerator}" is already assigned to ${conflict.label}.`;
      this.feedbackIsError = true;
      return;
    }
    this.updateShortcut(entry.id, accelerator);
  }

  private updateShortcut(id: string, accelerator: string | undefined): void {
    getDesktopShortcutService()?.update(id, accelerator);
    this.recordingId = undefined;
    this.feedback = accelerator
      ? `Saved ${formatDesktopAccelerator(accelerator, detectBrowserPlatform())}.`
      : 'Shortcut cleared.';
    this.feedbackIsError = false;
  }

  private resetAll(): void {
    getDesktopShortcutService()?.reset();
    this.recordingId = undefined;
    this.feedback = 'Restored all default shortcuts.';
    this.feedbackIsError = false;
  }

  private visibleEntries(): readonly DesktopShortcutEntry[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.entries;
    return this.entries.filter((entry) =>
      `${entry.label} ${entry.category} ${entry.id}`
        .toLowerCase()
        .includes(query),
    );
  }

  private renderEntry(entry: DesktopShortcutEntry): TemplateResult {
    const recording = this.recordingId === entry.id;
    const current = formatDesktopAccelerator(
      entry.accelerator,
      detectBrowserPlatform(),
    );
    const label = recording ? 'Press shortcut…' : (current ?? 'Not assigned');
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${entry.label}</span>
          <span class="settings-row-help">
            ${entry.category}
            <span class="shortcuts-command">${entry.id}</span>
          </span>
        </div>
        <div class="settings-row-control shortcuts-control">
          <wa-button
            class="shortcut-recorder btn-secondary"
            appearance="outlined"
            size="s"
            data-recording=${String(recording)}
            @click=${() => this.startRecording(entry.id)}
            @keydown=${(event: KeyboardEvent) =>
              this.captureShortcut(event, entry)}
          >
            ${waIcon('code', { slot: 'start' })} ${label}
          </wa-button>
          ${renderLabeledActionButton({
            icon: 'arrow-rotate-left',
            text: 'Reset',
            kind: 'secondary',
            appearance: 'outlined',
            label: `Reset ${entry.label}`,
            title: 'Reset to default',
            onClick: () =>
              this.updateShortcut(entry.id, entry.defaultAccelerator),
          })}
          ${renderIconActionButton({
            icon: 'xmark',
            label: `Clear ${entry.label}`,
            tooltip: 'Clear shortcut',
            onClick: () => this.updateShortcut(entry.id, undefined),
          })}
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const entries = this.visibleEntries();
    const groups = new Map<string, DesktopShortcutEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.category) ?? [];
      group.push(entry);
      groups.set(entry.category, group);
    }
    return html`
      <div class="tab-content-container">
        ${renderSettingsBanner({
          id: 'keyboard-shortcuts-banner',
          icon: 'code',
          title: 'Keyboard shortcuts',
          description:
            'Select a binding, then press the new chord. Changes apply immediately to the desktop app and persist for this profile.',
          actions: renderLabeledActionButton({
            icon: 'arrow-rotate-left',
            text: 'Reset all',
            kind: 'secondary',
            appearance: 'outlined',
            onClick: () => this.resetAll(),
          }),
        })}
        <wa-input
          class="shortcuts-search"
          type="search"
          placeholder="Filter shortcuts"
          aria-label="Filter shortcuts"
          @input=${this.handleSearch}
        ></wa-input>
        <p
          class="shortcuts-feedback"
          role="status"
          data-error=${String(this.feedbackIsError)}
        >
          ${this.feedback || nothing}
        </p>
        ${
          entries.length === 0
            ? renderEmptyState({
                icon: 'magnifying-glass',
                title: 'No matching commands.',
                body: 'Try a different search term.',
                headingTag: 'h3',
                className: 'empty-state',
              })
            : [...groups].map(
                ([category, categoryEntries]) => html`
                  <section>
                    ${renderSettingsSectionHeading({
                      title: `${category} (${categoryEntries.length})`,
                    })}
                    <div class="settings-section">
                      ${categoryEntries.map((entry) => this.renderEntry(entry))}
                    </div>
                  </section>
                `,
              )
        }
      </div>
    `;
  }
}


declare global {
  interface HTMLElementTagNameMap {
    'shortcuts-tab': ShortcutsTab;
  }
}

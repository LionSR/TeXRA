import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { commonViewStyles, designTokens } from '@shared/styles';
import { formatDesktopAccelerator } from '@shared/commands/accelerators';
import {
  DESKTOP_SHORTCUT_EVENTS,
  keyboardEventToAccelerator,
  type DesktopShortcutEntry,
  type DesktopShortcutState,
  type DesktopShortcutUpdate,
} from '@shared/commands/shortcutPreferences';
import { waIcon } from '@shared/wa/webAwesomeIcons';

@customElement('shortcuts-tab')
export class ShortcutsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .shortcuts-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--wa-space-s);
        margin-block-end: var(--wa-space-s);
      }

      .shortcuts-header-copy {
        min-width: 0;
      }

      .shortcuts-header h2 {
        margin: 0;
        font-size: var(--font-size-lg);
      }

      .shortcuts-header p,
      .shortcuts-feedback,
      .shortcuts-empty {
        color: var(--wa-color-text-quiet);
        font-size: var(--font-size-sm);
      }

      .shortcuts-header p {
        margin: var(--wa-space-3xs) 0 0;
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

      .shortcuts-feedback {
        min-height: 1.4em;
        margin: 0 0 var(--wa-space-xs);
      }

      .shortcuts-feedback[data-error='true'] {
        color: var(--wa-color-danger-60);
      }

      @container settings (max-width: 520px) {
        .shortcuts-header {
          flex-direction: column;
        }

        .settings-row {
          align-items: stretch;
          flex-direction: column;
          gap: var(--wa-space-xs);
        }

        .shortcuts-control {
          justify-content: flex-start;
        }
      }
    `,
  ];

  @property({ type: Boolean }) desktopHost = false;
  @state() private entries: readonly DesktopShortcutEntry[] = [];
  @state() private recordingId: string | undefined;
  @state() private query = '';
  @state() private feedback = '';
  @state() private feedbackIsError = false;

  private readonly handleState = (event: Event): void => {
    const state = (event as CustomEvent<DesktopShortcutState>).detail;
    this.entries = state.entries;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(DESKTOP_SHORTCUT_EVENTS.STATE, this.handleState);
    queueMicrotask(() => {
      window.dispatchEvent(new Event(DESKTOP_SHORTCUT_EVENTS.REQUEST));
    });
  }

  override disconnectedCallback(): void {
    window.removeEventListener(DESKTOP_SHORTCUT_EVENTS.STATE, this.handleState);
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

    const accelerator = keyboardEventToAccelerator(event, currentPlatform());
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
    const detail: DesktopShortcutUpdate = { id, accelerator };
    window.dispatchEvent(
      new CustomEvent(DESKTOP_SHORTCUT_EVENTS.UPDATE, { detail }),
    );
    this.recordingId = undefined;
    this.feedback = accelerator
      ? `Saved ${formatDesktopAccelerator(accelerator, currentPlatform())}.`
      : 'Shortcut cleared.';
    this.feedbackIsError = false;
  }

  private resetAll(): void {
    window.dispatchEvent(new Event(DESKTOP_SHORTCUT_EVENTS.RESET));
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
      currentPlatform(),
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
            class="shortcut-recorder"
            appearance="outlined"
            size="small"
            data-recording=${String(recording)}
            @click=${() => this.startRecording(entry.id)}
            @keydown=${(event: KeyboardEvent) =>
              this.captureShortcut(event, entry)}
          >
            ${waIcon('code', { slot: 'start' })} ${label}
          </wa-button>
          <wa-button
            class="icon-button is-size-m"
            appearance="plain"
            size="small"
            aria-label=${`Reset ${entry.label}`}
            title="Reset to default"
            @click=${() =>
              this.updateShortcut(entry.id, entry.defaultAccelerator)}
          >
            ${waIcon('arrow-rotate-left')}
          </wa-button>
          <wa-button
            class="icon-button is-size-m"
            appearance="plain"
            size="small"
            aria-label=${`Clear ${entry.label}`}
            title="Clear shortcut"
            @click=${() => this.updateShortcut(entry.id, undefined)}
          >
            ${waIcon('xmark')}
          </wa-button>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.desktopHost) {
      return html`
        <div class="tab-content-container settings-unavailable">
          Keyboard shortcuts are configured by VS Code in the extension host.
        </div>
      `;
    }
    const entries = this.visibleEntries();
    return html`
      <div class="tab-content-container">
        <div class="shortcuts-header">
          <div class="shortcuts-header-copy">
            <h2>Keyboard shortcuts</h2>
            <p>
              Select a binding, then press the new chord. Changes apply
              immediately and persist for this desktop profile.
            </p>
          </div>
          <wa-button appearance="outlined" size="small" @click=${this.resetAll}>
            ${waIcon('arrow-rotate-left', { slot: 'start' })} Reset all
          </wa-button>
        </div>
        <wa-input
          class="shortcuts-search"
          type="search"
          placeholder="Filter commands"
          aria-label="Filter keyboard shortcuts"
          @input=${this.handleSearch}
        ></wa-input>
        <p
          class="shortcuts-feedback"
          role="status"
          data-error=${String(this.feedbackIsError)}
        >
          ${this.feedback || nothing}
        </p>
        <div class="settings-section">
          ${
            entries.length === 0
              ? html`<p class="shortcuts-empty">No matching commands.</p>`
              : entries.map((entry) => this.renderEntry(entry))
          }
        </div>
      </div>
    `;
  }
}

function currentPlatform(): NodeJS.Platform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  return 'linux';
}

declare global {
  interface HTMLElementTagNameMap {
    'shortcuts-tab': ShortcutsTab;
  }
}

/**
 * In-app provider API key entry dialog.
 * Sends key values only in the submit event; it never receives stored values.
 */

import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens } from '@shared/styles';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared events
import { createEvent } from '@shared/utils/events';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

@customElement('provider-key-modal')
export class ProviderKeyModal extends LitElement {
  static override styles = [
    designTokens,
    css`
      /* wa-dialog supplies the backdrop, modal positioning, focus trap, escape
         handling, and panel chrome; only the body content layout lives here. */
      wa-dialog.provider-key-dialog {
        --width: min(560px, calc(100vw - var(--wa-space-xl, 32px)));
      }

      .provider-key-description {
        margin: 0 0 var(--wa-space-s);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      .provider-key-label {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
        font-weight: var(--font-weight-medium);
      }

      wa-input.provider-key-input {
        display: block;
        width: 100%;
      }

      .provider-key-error {
        min-height: 1.4em;
        margin: var(--wa-space-2xs) 0 0;
        color: var(--wa-color-danger-on-quiet, var(--color-error));
        font-size: var(--font-size-sm);
      }

      .provider-key-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--wa-space-xs);
      }
    `,
  ];

  @property() provider = '';
  @property() displayName = '';

  @state() private value = '';
  @state() private error = '';

  @query('wa-input.provider-key-input') private keyInput?: WaInput;

  // Drives wa-dialog's `open` reactive property; toggled by close() so the
  // dialog plays its hide animation and dispatches wa-after-hide.
  @state() private dialogOpen = true;

  // Distinguishes a user-initiated close (Escape / Cancel button / dialog close
  // button) from a programmatic close after submit. Submit dispatches its own
  // event and suppresses the cancel dispatch on the subsequent wa-after-hide.
  private suppressCancel = false;

  private clearSecretValue(): void {
    this.value = '';
    if (this.keyInput) {
      this.keyInput.value = '';
    }
  }

  private close(): void {
    this.dialogOpen = false;
  }

  private handleAfterShow(): void {
    this.keyInput?.focus();
  }

  private handleAfterHide(): void {
    if (this.suppressCancel) {
      this.suppressCancel = false;
      return;
    }
    this.clearSecretValue();
    this.error = '';
    this.dispatchEvent(createEvent('provider-key-cancel'));
  }

  private handleInput(event: Event): void {
    this.value = (event.target as WaInput).value ?? '';
    if (this.error) {
      this.error = '';
    }
  }

  private handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const apiKey = this.value.trim();
    if (!apiKey) {
      this.error = 'Enter an API key before saving.';
      this.keyInput?.focus();
      return;
    }

    this.clearSecretValue();
    this.error = '';
    this.suppressCancel = true;
    this.dispatchEvent(
      createEvent('provider-key-submit', {
        provider: this.provider,
        apiKey,
      }),
    );
    this.close();
  }

  override render(): TemplateResult {
    const displayName = this.displayName || this.provider;
    return html`
      <wa-dialog
        class="provider-key-dialog"
        label=${`Set ${displayName} API key`}
        ?open=${this.dialogOpen}
        @wa-after-show=${this.handleAfterShow}
        @wa-after-hide=${this.handleAfterHide}
      >
        <form id="provider-key-form" @submit=${this.handleSubmit}>
          <p class="provider-key-description">
            The key is stored by TeXRA on this device and is not shown again
            after saving.
          </p>
          <label class="provider-key-label">
            ${displayName} API key
            <wa-input
              class="provider-key-input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              .value=${this.value}
              @input=${this.handleInput}
            ></wa-input>
          </label>
          <p class="provider-key-error" aria-live="polite">${this.error}</p>
        </form>
        <div slot="footer" class="provider-key-actions">
          <wa-button
            appearance="outlined"
            variant="neutral"
            type="button"
            @click=${() => this.close()}
          >
            Cancel
          </wa-button>
          <wa-button
            appearance="filled"
            variant="brand"
            type="submit"
            form="provider-key-form"
          >
            ${waIcon('key', { slot: 'start' })} Save key
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'provider-key-modal': ProviderKeyModal;
  }
}

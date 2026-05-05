/**
 * ProviderKeyModal component - in-app provider API key entry.
 * Sends key values only in the submit event; it never receives stored values.
 */

// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens } from '@shared/styles';

// Local imports - shared events
import { createEvent } from '@shared/utils/events';

@customElement('provider-key-modal')
export class ProviderKeyModal extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
      }

      .provider-key-backdrop {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        padding: var(--spacing-xlarge);
        background: color-mix(
          in srgb,
          var(--texra-editor-background) 35%,
          transparent
        );
      }

      .provider-key-dialog {
        width: min(560px, 100%);
        padding: var(--spacing-xlarge);
        color: var(--texra-foreground);
        background: var(--texra-editor-background);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius-large);
        box-shadow: 0 12px 32px
          color-mix(in srgb, var(--texra-editor-foreground) 18%, transparent);
      }

      .provider-key-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--spacing-large);
        margin-bottom: var(--spacing-medium);
      }

      h2 {
        margin: 0;
        font-size: var(--font-size-lg);
      }

      .provider-key-description {
        margin: 0 0 var(--spacing-large);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      label {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        font-weight: var(--font-weight-medium);
      }

      input {
        width: 100%;
        box-sizing: border-box;
        height: 34px;
        padding: var(--spacing-small) var(--spacing-medium);
        color: var(--texra-input-foreground);
        background: var(--texra-input-background);
        border: var(--border-thin) solid var(--texra-input-border);
        border-radius: var(--border-radius);
        font: inherit;
      }

      input:focus {
        outline: var(--border-thin) solid var(--texra-focusBorder);
        outline-offset: 1px;
      }

      .provider-key-error {
        min-height: 1.4em;
        margin: var(--spacing-small) 0 0;
        color: var(--texra-errorForeground, var(--color-error));
        font-size: var(--font-size-sm);
      }

      .provider-key-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-medium);
        margin-top: var(--spacing-large);
      }

      button {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        min-height: var(--height-button);
        padding: var(--spacing-small) var(--spacing-large);
        border-radius: var(--border-radius);
        font: inherit;
        cursor: pointer;
      }

      .provider-key-primary {
        color: var(--texra-button-foreground);
        background: var(--texra-button-background);
        border: var(--border-thin) solid var(--texra-button-background);
      }

      .provider-key-primary:hover {
        background: var(--texra-button-hoverBackground);
      }

      .provider-key-secondary,
      .provider-key-icon {
        color: var(--texra-foreground);
        background: transparent;
        border: var(--border-thin) solid var(--color-border);
      }

      .provider-key-secondary:hover,
      .provider-key-icon:hover {
        background: var(--texra-list-hoverBackground);
      }

      .provider-key-icon {
        min-width: 30px;
        justify-content: center;
        padding: var(--spacing-small);
      }
    `,
  ];

  @property() provider = '';
  @property() displayName = '';

  @state() private value = '';
  @state() private error = '';

  @query('input') private keyInput?: HTMLInputElement;

  override firstUpdated(): void {
    this.keyInput?.focus();
  }

  private close(): void {
    this.value = '';
    this.error = '';
    this.dispatchEvent(createEvent('provider-key-cancel'));
  }

  private handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  private handleInput(event: Event): void {
    this.value = (event.target as HTMLInputElement).value;
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

    this.dispatchEvent(
      createEvent('provider-key-submit', {
        provider: this.provider,
        apiKey,
      }),
    );
    this.value = '';
    if (this.keyInput) {
      this.keyInput.value = '';
    }
    this.error = '';
  }

  override render(): TemplateResult {
    const displayName = this.displayName || this.provider;
    return html`
      <div
        class="provider-key-backdrop"
        role="presentation"
        @click=${this.handleBackdropClick}
      >
        <form
          class="provider-key-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-key-title"
          @submit=${this.handleSubmit}
        >
          <div class="provider-key-header">
            <h2 id="provider-key-title">Set ${displayName} API key</h2>
            <button
              class="provider-key-icon codicon codicon-close"
              type="button"
              title="Cancel"
              aria-label="Cancel"
              @click=${this.close}
            ></button>
          </div>
          <p class="provider-key-description">
            The key is stored by TeXRA on this device and is not shown again
            after saving.
          </p>
          <label>
            ${displayName} API key
            <input
              type="password"
              autocomplete="off"
              spellcheck="false"
              .value=${this.value}
              @input=${this.handleInput}
            />
          </label>
          <p class="provider-key-error" aria-live="polite">${this.error}</p>
          <div class="provider-key-actions">
            <button
              class="provider-key-secondary"
              type="button"
              @click=${this.close}
            >
              Cancel
            </button>
            <button class="provider-key-primary" type="submit">
              <span class="codicon codicon-key"></span>
              Save Key
            </button>
          </div>
        </form>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'provider-key-modal': ProviderKeyModal;
  }
}

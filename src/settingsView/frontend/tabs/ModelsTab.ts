/**
 * ModelsTab component - API access, provider keys, and model selection for settings view.
 * Shows provider key list for all users; authenticated users also see API access mode.
 * Model selection list allows toggling which models appear in the dropdown.
 */

// Third-party imports
import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type {
  ProviderKeyStatus,
  ModelSelectionItem,
} from '@shared/schemas/settingsViewMessages';

// Local imports - settings view components (side-effect: register)
import '../components/profile/ApiAccessSection';
import '../components/profile/ProviderKeyList';
import '../components/profile/ModelSelectionList';

@customElement('models-tab')
export class ModelsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    css`
      :host {
        display: block;
      }

      /* max-width and centering provided by .tab-content-container */

      .models-tab-hint {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-medium);
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-large);
        border: var(--border-thin) solid
          var(--vscode-editorInfo-foreground, #3794ff);
        border-radius: var(--border-radius);
        background: var(--vscode-editor-background);
      }

      .models-tab-hint .codicon-info {
        flex-shrink: 0;
        font-size: var(--font-size-lg);
        color: var(--vscode-editorInfo-foreground, #3794ff);
        margin-top: 2px;
      }

      .models-tab-hint-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
      }

      .models-tab-hint-title {
        font-weight: var(--font-weight-medium);
        color: var(--vscode-foreground);
      }

      .models-tab-hint-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      .models-tab-hint-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--spacing-small);
      }

      .models-tab-hint-link {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        padding: var(--spacing-tiny) var(--spacing-small);
        background: none;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius-small);
        color: var(--vscode-textLink-foreground);
        font: inherit;
        font-size: var(--font-size-sm);
        cursor: pointer;
      }

      .models-tab-hint-link:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder);
      }

      .models-tab-hint-link:focus-visible {
        outline: var(--border-thin) solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
    `,
  ];

  @property({ attribute: false }) authenticated = false;
  @property({ attribute: false }) apiAccessMode: 'included' | 'personal' =
    'personal';
  @property({ attribute: false }) allowedModels: string[] | null = [];
  @property({ attribute: false }) providerKeyStatuses: ProviderKeyStatus[] = [];
  @property({ attribute: false }) globalStreamingDefault = true;
  @property({ attribute: false }) modelSelectionItems: ModelSelectionItem[] =
    [];
  @property({ attribute: false }) helperModel = '';
  @property({ type: Boolean }) preferShortModelNames = false;

  private scrollToSection(tagName: string): void {
    const el = this.shadowRoot?.querySelector(tagName);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private renderTabHint(): TemplateResult | typeof nothing {
    if (this.providerKeyStatuses.length === 0) {
      return nothing;
    }

    const description =
      this.apiAccessMode === 'included'
        ? 'Personal provider API keys are optional overrides—configure them in the API Configuration section below.'
        : 'To use your own keys for OpenAI, Anthropic, Google, and other providers, scroll to the API Configuration section below.';

    const accessJump = this.authenticated
      ? html`<button
          class="models-tab-hint-link"
          @click=${() => this.scrollToSection('api-access-section')}
        >
          Model Access
        </button>`
      : nothing;

    return html`
      <div class="models-tab-hint" role="note">
        <span class="codicon codicon-info"></span>
        <div class="models-tab-hint-body">
          <div class="models-tab-hint-title">
            Looking for API key settings?
          </div>
          <div class="models-tab-hint-description">${description}</div>
          <div class="models-tab-hint-actions">
            ${accessJump}
            <button
              class="models-tab-hint-link"
              @click=${() => this.scrollToSection('provider-key-list')}
            >
              <span class="codicon codicon-key"></span>
              Jump to API Configuration
            </button>
          </div>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const apiAccessSection = this.authenticated
      ? html`<api-access-section
          .mode=${this.apiAccessMode}
        ></api-access-section>`
      : nothing;

    return html`
      <div class="models-container tab-content-container">
        ${this.renderTabHint()} ${apiAccessSection}
        <model-selection-list
          .models=${this.modelSelectionItems}
          .helperModel=${this.helperModel}
          .authenticated=${this.authenticated}
          .apiAccessMode=${this.apiAccessMode}
          .allowedModels=${this.allowedModels}
          .preferShortModelNames=${this.preferShortModelNames}
        ></model-selection-list>
        <provider-key-list
          .providerKeyStatuses=${this.providerKeyStatuses}
          .apiAccessMode=${this.apiAccessMode}
          .globalStreamingDefault=${this.globalStreamingDefault}
        ></provider-key-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'models-tab': ModelsTab;
  }
}

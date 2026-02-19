/**
 * LaTeXTab component - shows recommended LaTeX-related VS Code settings
 * and lets the user apply them with a single click.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type { LatexSettingsStatus } from '@shared/schemas/settingsViewMessages';

/** Metadata for each recommended setting. */
interface SettingInfo {
  readonly key: keyof LatexSettingsStatus;
  readonly name: string;
  readonly configKey: string;
  readonly value: string;
  readonly description: string;
}

const RECOMMENDED_SETTINGS: SettingInfo[] = [
  {
    key: 'outDir',
    name: 'LaTeX Output Directory',
    configKey: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    description:
      'Redirect compilation artifacts to a build/ subfolder, keeping your project root clean.',
  },
  {
    key: 'autoRevealExclude',
    name: 'Explorer Auto-Reveal Exclude',
    configKey: 'explorer.autoRevealExclude',
    value: '{ "**/build/": true }',
    description:
      'Prevent the build/ folder from being auto-revealed in the Explorer sidebar.',
  },
];

@customElement('latex-tab')
export class LaTeXTab extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .latex-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--spacing-large);
      }

      .latex-title {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        font-size: var(--font-size-lg);
        font-weight: 500;
        color: var(--vscode-foreground);
      }

      .latex-description {
        margin-bottom: var(--spacing-large);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        line-height: 1.5;
      }

      .dependency-card {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-large);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--radius-medium);
        background: var(--vscode-editor-background);
      }

      .dependency-icon {
        flex-shrink: 0;
        font-size: var(--font-size-lg);
      }

      .dependency-icon.installed {
        color: var(--vscode-testing-iconPassed, #73c991);
      }

      .dependency-icon.missing {
        color: var(--vscode-testing-iconFailed, #f48771);
      }

      .dependency-info {
        flex: 1;
        min-width: 0;
      }

      .dependency-name {
        font-weight: 500;
        color: var(--vscode-foreground);
      }

      .dependency-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-top: 2px;
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding-bottom: var(--spacing-small);
        margin-bottom: var(--spacing-medium);
        border-bottom: var(--border-thin) solid var(--color-border);
        font-size: var(--font-size-sm);
        font-weight: 500;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .setting-card {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-medium);
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-medium);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--radius-medium);
        background: var(--vscode-editor-background);
      }

      .setting-status-icon {
        flex-shrink: 0;
        margin-top: 2px;
        font-size: var(--font-size-lg);
      }

      .setting-status-icon.is-set {
        color: var(--vscode-testing-iconPassed, #73c991);
      }

      .setting-status-icon.not-set {
        color: var(--vscode-testing-iconFailed, #f48771);
      }

      .setting-info {
        flex: 1;
        min-width: 0;
      }

      .setting-name {
        font-weight: 500;
        color: var(--vscode-foreground);
        margin-bottom: 2px;
      }

      .setting-config-key {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-small);
      }

      .setting-value {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--font-size-sm);
        color: var(--vscode-textLink-foreground);
      }

      .setting-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: 1.4;
        margin-top: var(--spacing-small);
      }

      .setting-badge {
        flex-shrink: 0;
        font-size: var(--font-size-xs, 11px);
        padding: 2px 6px;
        border-radius: var(--radius-small, 3px);
        font-weight: 500;
      }

      .setting-badge.is-set {
        background: var(--vscode-testing-iconPassed, #73c991);
        color: var(--vscode-editor-background);
      }

      .setting-badge.not-set {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
    `,
  ];

  @property({ attribute: false })
  settings: LatexSettingsStatus = {
    outDir: false,
    autoRevealExclude: false,
    latexWorkshopInstalled: false,
    latexdiffInstalled: false,
  };

  @property({ type: Boolean }) loaded = false;

  private handleApply(field?: SettingInfo['key']): void {
    this.dispatchEvent(
      new CustomEvent('latex-apply-settings', {
        bubbles: true,
        composed: true,
        detail: field ? { field } : {},
      }),
    );
  }

  private handleInstallWorkshop(): void {
    this.dispatchEvent(
      new CustomEvent('latex-install-workshop', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private allSettingsSet(): boolean {
    return this.settings.outDir && this.settings.autoRevealExclude;
  }

  private renderDependencyCard(
    name: string,
    installed: boolean,
    installedDesc: string,
    missingDesc: string,
    action?: TemplateResult,
  ): TemplateResult {
    return html`
      <div class="dependency-card">
        <span
          class="codicon dependency-icon ${installed
            ? 'installed codicon-check'
            : 'missing codicon-warning'}"
        ></span>
        <div class="dependency-info">
          <div class="dependency-name">${name}</div>
          <div class="dependency-description">
            ${installed ? installedDesc : missingDesc}
          </div>
        </div>
        ${installed
          ? html`<span class="setting-badge is-set">Installed</span>`
          : (action ??
            html`<span class="setting-badge not-set">Not found</span>`)}
      </div>
    `;
  }

  private renderDependencies(): TemplateResult {
    return html`
      <div class="section-header">
        <span class="codicon codicon-package"></span>
        Dependencies
      </div>
      ${this.renderDependencyCard(
        'LaTeX Workshop',
        this.settings.latexWorkshopInstalled,
        'Installed — provides LaTeX compilation, PDF preview, and IntelliSense.',
        'Not installed — required for LaTeX compilation, PDF preview, and IntelliSense.',
        html`
          <button
            class="tab-action-btn"
            @click=${this.handleInstallWorkshop}
            title="Install LaTeX Workshop extension"
          >
            <span class="codicon codicon-cloud-download"></span>
            Install
          </button>
        `,
      )}
      ${this.renderDependencyCard(
        'latexdiff',
        this.settings.latexdiffInstalled,
        'Installed — enables visual comparison of LaTeX document revisions.',
        'Not found — install via your TeX distribution to enable diff comparisons.',
      )}
    `;
  }

  private renderSettingCard(info: SettingInfo): TemplateResult {
    const isSet = this.settings[info.key];
    return html`
      <div class="setting-card">
        <span
          class="codicon setting-status-icon ${isSet
            ? 'is-set'
            : 'not-set'} ${isSet ? 'codicon-check' : 'codicon-warning'}"
        ></span>
        <div class="setting-info">
          <div class="setting-name">${info.name}</div>
          <div class="setting-config-key">${info.configKey}</div>
          <div class="setting-value">${info.value}</div>
          <div class="setting-description">${info.description}</div>
        </div>
        ${isSet
          ? html`<span class="setting-badge is-set">Set</span>`
          : html`
              <button
                class="tab-action-btn"
                @click=${() => this.handleApply(info.key)}
                title="Apply this setting"
              >
                <span class="codicon codicon-check"></span>
                Apply
              </button>
            `}
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.loaded) {
      return html`
        <div class="tab-content-container">
          <div
            style="text-align:center;padding:var(--spacing-large);color:var(--color-text-secondary)"
          >
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
            Loading LaTeX settings...
          </div>
        </div>
      `;
    }

    return html`
      <div class="tab-content-container">
        <div class="latex-header">
          <div class="latex-title">
            <span class="codicon codicon-file-code"></span>
            LaTeX Settings
          </div>
          ${!this.allSettingsSet()
            ? html`
                <button
                  class="tab-action-btn"
                  @click=${() => this.handleApply()}
                  title="Apply all recommended settings"
                >
                  <span class="codicon codicon-check-all"></span>
                  Apply All
                </button>
              `
            : nothing}
        </div>

        ${this.renderDependencies()}

        <div class="section-header" style="margin-top:var(--spacing-large)">
          <span class="codicon codicon-settings-gear"></span>
          Recommended Settings
        </div>

        <div class="latex-description">
          Agents create temporary files during compilation. The following VS
          Code settings are recommended to keep your workspace tidy and avoid
          distracting sidebar activity.
        </div>

        ${RECOMMENDED_SETTINGS.map((info) => this.renderSettingCard(info))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'latex-tab': LaTeXTab;
  }
}

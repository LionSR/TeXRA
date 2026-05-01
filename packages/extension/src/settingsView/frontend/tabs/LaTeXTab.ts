/**
 * LaTeXTab component - shows recommended LaTeX-related VS Code settings
 * and lets the user apply them with a single click.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type LatexConfigValues,
  type LatexSettingsStatus,
} from '@shared/schemas/settingsViewMessages';

// Local imports - LaTeX config constants (shared with backend + readers)
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
} from '@shared/constants/latex';

// Local imports - shared constants
import {
  PDFLATEX_INSTALL_GUIDE,
  LATEXDIFF_INSTALL_GUIDE,
  LATEXINDENT_INSTALL_GUIDE,
  TEXCOUNT_INSTALL_GUIDE,
  IMAGE_PROCESSING_INSTALL_GUIDE,
  DEPENDENCY_INSTALL_COMMANDS,
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  type InstallCommand,
  type Platform,
} from '@shared/constants/latex';

// Local imports - shared utilities
import { copyTextToClipboard } from '@shared/utils/clipboard';
import { createEvent } from '@shared/utils/events';

/** Path keys in LatexSettingsStatus for tool paths. */
type ToolPathKey =
  | 'pdflatexPath'
  | 'latexmkPath'
  | 'latexdiffPath'
  | 'latexindentPath'
  | 'texcountPath'
  | 'ghostscriptPath'
  | 'graphicsmagickPath';

/** Metadata for a dependency shown in the Dependencies section. */
interface DependencyInfo {
  readonly key: keyof LatexSettingsStatus;
  readonly name: string;
  readonly installedDesc: string;
  readonly missingDesc: string;
  readonly installGuide?: Record<Platform, string>;
  /** Keys to check for detected tool paths (shown when installed). */
  readonly pathKeys?: ToolPathKey[];
  /** If provided, renders an action button when missing (e.g. VS Code install). */
  readonly actionEvent?: string;
  readonly actionLabel?: string;
}

const DEPENDENCIES: DependencyInfo[] = [
  {
    key: 'texDistributionInstalled',
    name: 'TeX Distribution',
    installedDesc: 'pdflatex/latexmk detected on PATH.',
    missingDesc:
      'A TeX distribution (TeX Live, MacTeX, or MiKTeX) is required to compile LaTeX documents.',
    installGuide: PDFLATEX_INSTALL_GUIDE,
    pathKeys: ['pdflatexPath', 'latexmkPath'],
  },
  {
    key: 'latexWorkshopInstalled',
    name: 'LaTeX Workshop',
    installedDesc: 'Provides LaTeX compilation, PDF preview, and IntelliSense.',
    missingDesc:
      'Required for LaTeX compilation, PDF preview, and IntelliSense.',
    actionEvent: 'latex-install-workshop',
    actionLabel: 'Install',
  },
  {
    key: 'latexdiffInstalled',
    name: 'latexdiff',
    installedDesc: 'Enables visual comparison of LaTeX document revisions.',
    missingDesc:
      'Install via your TeX distribution to enable diff comparisons.',
    installGuide: LATEXDIFF_INSTALL_GUIDE,
    pathKeys: ['latexdiffPath'],
  },
  {
    key: 'latexindentInstalled',
    name: 'latexindent',
    installedDesc:
      'Used by agents to clean up formatting after editing your LaTeX source.',
    missingDesc:
      'Without it, agents may produce inconsistent indentation ' +
      'when editing .tex files. Requires Perl.',
    installGuide: LATEXINDENT_INSTALL_GUIDE,
    pathKeys: ['latexindentPath'],
  },
  {
    key: 'texcountInstalled',
    name: 'TeXcount',
    installedDesc:
      'Enables word, heading, and figure counting in LaTeX documents.',
    missingDesc:
      'Without it, agents cannot count words or structural elements in your .tex files. ' +
      'Part of most TeX Live distributions.',
    installGuide: TEXCOUNT_INSTALL_GUIDE,
    pathKeys: ['texcountPath'],
  },
  {
    key: 'imageProcessingInstalled',
    name: 'Image Processing',
    installedDesc:
      'Ghostscript + GraphicsMagick/ImageMagick detected for PDF-to-PNG conversion.',
    missingDesc:
      'Needed to generate PNG previews of compiled PDF pages. ' +
      'Requires Ghostscript and either GraphicsMagick or ImageMagick.',
    installGuide: IMAGE_PROCESSING_INSTALL_GUIDE,
    pathKeys: ['ghostscriptPath', 'graphicsmagickPath'],
  },
];

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
        font-weight: var(--font-weight-medium);
        color: var(--texra-foreground);
      }

      .latex-description {
        margin-bottom: var(--spacing-large);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-relaxed);
      }

      .dependency-card {
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-medium);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        background: var(--texra-editor-background);
      }

      .dependency-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-medium);
      }

      .dependency-icon {
        flex-shrink: 0;
        font-size: var(--font-size-lg);
      }

      .dependency-icon.installed {
        color: var(--texra-testing-iconPassed, #73c991);
      }

      .dependency-icon.missing {
        color: var(--texra-testing-iconFailed, #f48771);
      }

      .dependency-info {
        flex: 1;
        min-width: 0;
      }

      .dependency-name {
        font-weight: var(--font-weight-medium);
        color: var(--texra-foreground);
      }

      .dependency-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-top: var(--spacing-tiny);
      }

      .dependency-guide-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        margin-top: var(--spacing-small);
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--texra-textLink-foreground, #3794ff);
        background: none;
        border: none;
        cursor: pointer;
        transition: opacity var(--transition-fast);
      }

      .dependency-guide-toggle:hover {
        opacity: var(--opacity-hover);
      }

      .dependency-guide {
        margin-top: var(--spacing-small);
        padding: var(--spacing-medium);
        background: var(
          --texra-textCodeBlock-background,
          rgba(128, 128, 128, 0.08)
        );
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        color: var(--texra-foreground);
        line-height: var(--line-height-relaxed);
        white-space: pre-wrap;
      }

      .dependency-path {
        margin-top: 4px;
        font-family: var(--texra-editor-font-family, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .dependency-install-actions {
        display: flex;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .install-command-text {
        flex: 1;
        min-width: 0;
        padding: var(--spacing-small) var(--spacing-medium);
        background: var(
          --texra-textCodeBlock-background,
          rgba(128, 128, 128, 0.08)
        );
        border-radius: var(--border-radius-small);
        font-family: var(--texra-editor-font-family, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--texra-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .copy-success {
        color: var(--texra-testing-iconPassed, #73c991) !important;
        border-color: var(--texra-testing-iconPassed, #73c991) !important;
      }

      .prerequisite-hint {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-medium);
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-medium);
        border: var(--border-thin) solid
          var(--texra-editorInfo-foreground, #3794ff);
        border-radius: var(--border-radius);
        background: var(--texra-editor-background);
      }

      .prerequisite-hint .hint-icon {
        flex-shrink: 0;
        font-size: var(--font-size-lg);
        color: var(--texra-editorInfo-foreground, #3794ff);
      }

      .prerequisite-hint .hint-body {
        flex: 1;
        min-width: 0;
      }

      .prerequisite-hint .hint-title {
        font-weight: var(--font-weight-medium);
        color: var(--texra-foreground);
        margin-bottom: var(--spacing-tiny);
      }

      .prerequisite-hint .hint-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      .prerequisite-hint .hint-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        padding-bottom: var(--spacing-small);
        margin-bottom: var(--spacing-medium);
        border-bottom: var(--border-thin) solid var(--color-border);
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-medium);
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
        border-radius: var(--border-radius);
        background: var(--texra-editor-background);
      }

      .setting-status-icon {
        flex-shrink: 0;
        margin-top: 2px;
        font-size: var(--font-size-lg);
      }

      .setting-status-icon.is-set {
        color: var(--texra-testing-iconPassed, #73c991);
      }

      .setting-status-icon.not-set {
        color: var(--texra-testing-iconFailed, #f48771);
      }

      .setting-info {
        flex: 1;
        min-width: 0;
      }

      .setting-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        white-space: nowrap;
      }

      .setting-name {
        font-weight: var(--font-weight-medium);
        color: var(--texra-foreground);
        margin-bottom: 2px;
      }

      .setting-config-key {
        font-family: var(--texra-editor-font-family, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-small);
      }

      .setting-value {
        font-family: var(--texra-editor-font-family, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--texra-textLink-foreground);
      }

      .setting-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
        margin-top: var(--spacing-small);
      }

      .setting-badge {
        flex-shrink: 0;
        font-size: var(--font-size-xs);
        padding: var(--spacing-tiny) var(--border-radius-large);
        border-radius: var(--border-radius-small);
        font-weight: var(--font-weight-medium);
      }

      .setting-badge.is-set {
        background: var(--texra-testing-iconPassed, #73c991);
        color: var(--texra-editor-background);
      }

      .setting-badge.not-set {
        background: var(--texra-badge-background);
        color: var(--texra-badge-foreground);
      }
    `,
  ];

  @property({ attribute: false })
  settings: LatexSettingsStatus = { ...DEFAULT_LATEX_SETTINGS_STATUS };

  @property({ type: Boolean }) loaded = false;

  @property({ attribute: false })
  configValues: LatexConfigValues = {};

  @property({ type: Boolean, attribute: 'config-loaded' }) configLoaded = false;
  @property({ type: Boolean }) inlineCriticismEnabled = false;
  @property({ type: Boolean, attribute: 'desktop-host' }) desktopHost = false;

  @state() private expandedGuides = new Set<string>();

  private toggleGuide(key: string): void {
    const next = new Set(this.expandedGuides);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.expandedGuides = next;
  }

  private handleApply(field?: SettingInfo['key'], reset = false): void {
    this.dispatchEvent(createEvent('latex-apply-settings', { field, reset }));
  }

  private handleInlineCriticismToggle(event: Event): void {
    this.dispatchEvent(
      createEvent('inline-criticism-toggle', {
        enabled: (event.target as HTMLInputElement).checked,
      }),
    );
  }

  private allSettingsSet(): boolean {
    return this.settings.outDir && this.settings.autoRevealExclude;
  }

  /**
   * Return the best install command for a missing dependency, or null if no
   * usable option exists (e.g. required package manager is not installed,
   * or no commands are defined for this platform).
   *
   * Iterates the ranked option list and picks the first whose package
   * manager is either detected on the system or is `null` (always available).
   */
  private getInstallCommand(dep: DependencyInfo): InstallCommand | null {
    const platform = this.settings.platform as Platform;
    const commands = DEPENDENCY_INSTALL_COMMANDS[dep.key];
    if (!commands) return null;
    const options = commands[platform];
    if (!options?.length) return null;
    const pm = this.settings.packageManager;
    return (
      options.find((cmd) => !cmd.packageManager || cmd.packageManager === pm) ??
      null
    );
  }

  private async handleCopyCommand(e: Event, command: string): Promise<void> {
    const button = (e.currentTarget ?? e.target) as HTMLElement;
    const ok = await copyTextToClipboard(command);
    if (ok) {
      button.classList.add('copy-success');
      button.setAttribute('title', 'Copied!');
      setTimeout(() => {
        button.classList.remove('copy-success');
        button.setAttribute('title', 'Copy command');
      }, 2000);
    }
  }

  private handleRunInTerminal(command: string): void {
    this.dispatchEvent(
      createEvent('latex-run-install-command', { installCommand: command }),
    );
  }

  /** Collect detected tool paths for a dependency. */
  private getDetectedPaths(dep: DependencyInfo): string[] {
    if (!dep.pathKeys) return [];
    return dep.pathKeys
      .map((k) => this.settings[k])
      .filter((v): v is string => v !== null && v !== undefined);
  }

  private renderDependencyCard(dep: DependencyInfo): TemplateResult {
    const installed = this.settings[dep.key];
    const expanded = this.expandedGuides.has(dep.key);
    const platform = this.settings.platform as Platform;
    const guideText = dep.installGuide?.[platform] ?? dep.installGuide?.linux;
    const detectedPaths = installed ? this.getDetectedPaths(dep) : [];
    const installCmd = !installed ? this.getInstallCommand(dep) : null;

    return html`
      <div class="dependency-card">
        <div class="dependency-row">
          <span
            class="codicon dependency-icon ${installed
              ? 'installed codicon-check'
              : 'missing codicon-warning'}"
          ></span>
          <div class="dependency-info">
            <div class="dependency-name">${dep.name}</div>
            <div class="dependency-description">
              ${installed ? dep.installedDesc : dep.missingDesc}
            </div>
            ${detectedPaths.map(
              (p) => html`<div class="dependency-path">${p}</div>`,
            )}
          </div>
          ${installed
            ? html`<span class="setting-badge is-set">Installed</span>`
            : dep.actionEvent
              ? html`
                  <button
                    class="tab-action-btn"
                    @click=${() =>
                      this.dispatchEvent(
                        new CustomEvent(dep.actionEvent!, {
                          bubbles: true,
                          composed: true,
                        }),
                      )}
                    title="${dep.actionLabel ?? 'Install'}"
                  >
                    <span class="codicon codicon-cloud-download"></span>
                    ${dep.actionLabel ?? 'Install'}
                  </button>
                `
              : html`<span class="setting-badge not-set">Not found</span>`}
        </div>
        ${!installed && installCmd
          ? html`
              <div class="dependency-install-actions">
                <button
                  class="tab-action-btn"
                  title="Copy: ${installCmd.command}"
                  @click=${(e: Event) =>
                    this.handleCopyCommand(e, installCmd.command)}
                >
                  <span class="codicon codicon-copy"></span>
                  Copy
                </button>
                <button
                  class="tab-action-btn"
                  title="Run: ${installCmd.command}"
                  @click=${() => this.handleRunInTerminal(installCmd.command)}
                >
                  <span class="codicon codicon-terminal"></span>
                  Run in Terminal
                </button>
              </div>
            `
          : nothing}
        ${!installed && guideText
          ? html`
              <button
                class="dependency-guide-toggle"
                @click=${() => this.toggleGuide(dep.key)}
              >
                <span
                  class="codicon ${expanded
                    ? 'codicon-chevron-down'
                    : 'codicon-chevron-right'}"
                ></span>
                Installation Guide
              </button>
              ${expanded
                ? html`<div class="dependency-guide">${guideText}</div>`
                : nothing}
            `
          : nothing}
      </div>
    `;
  }

  /**
   * Show a hint when the platform has a recommended package manager
   * that isn't installed yet (e.g. Homebrew on macOS, Scoop on Windows).
   */
  private renderPrerequisiteHint(): TemplateResult | typeof nothing {
    const platform = this.settings.platform as Platform;
    const pm = this.settings.packageManager;

    // macOS without Homebrew — installing it unlocks every brew command
    if (platform === 'darwin' && pm !== 'brew') {
      return this.renderPmHint(
        'Homebrew not detected',
        'Most dependencies below can be installed with a single brew install command. Install Homebrew first to enable quick-install buttons.',
        HOMEBREW_INSTALL_COMMAND,
        'Homebrew',
      );
    }

    // Windows without Scoop — installing it unlocks scoop commands
    if (platform === 'win32' && pm !== 'scoop') {
      return this.renderPmHint(
        'Scoop not detected',
        'Some dependencies below can be installed with a single scoop install command. Install Scoop first to enable quick-install buttons.',
        SCOOP_INSTALL_COMMAND,
        'Scoop',
      );
    }

    return nothing;
  }

  /** Render a package-manager prerequisite hint banner. */
  private renderPmHint(
    title: string,
    description: string,
    installCommand: string,
    pmName: string,
  ): TemplateResult {
    return html`
      <div class="prerequisite-hint">
        <span class="codicon codicon-info hint-icon"></span>
        <div class="hint-body">
          <div class="hint-title">${title}</div>
          <div class="hint-description">${description}</div>
          <div class="hint-actions">
            <code class="install-command-text">${installCommand}</code>
            <button
              class="tab-action-btn"
              title="Copy ${pmName} install command"
              @click=${(e: Event) => this.handleCopyCommand(e, installCommand)}
            >
              <span class="codicon codicon-copy"></span>
              Copy
            </button>
            <button
              class="tab-action-btn"
              title=${this.desktopHost
                ? `Run ${pmName} installer`
                : `Run ${pmName} installer in VS Code terminal`}
              @click=${() => this.handleRunInTerminal(installCommand)}
            >
              <span class="codicon codicon-terminal"></span>
              Run in Terminal
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderDependencies(): TemplateResult {
    const dependencies = this.desktopHost
      ? DEPENDENCIES.filter((dep) => dep.key !== 'latexWorkshopInstalled')
      : DEPENDENCIES;

    return html`
      <div class="section-header">
        <span class="codicon codicon-package"></span>
        Dependencies
      </div>
      ${this.renderPrerequisiteHint()}
      ${dependencies.map((dep) => this.renderDependencyCard(dep))}
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
          ? html`
              <button
                class="tab-action-btn"
                @click=${() => this.handleApply(info.key, true)}
                title="Reset this setting to default"
              >
                <span class="codicon codicon-discard"></span>
                Reset
              </button>
            `
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
        ${!this.desktopHost && !this.allSettingsSet()
          ? html`
              <div class="latex-header">
                <button
                  class="tab-action-btn"
                  @click=${() => this.handleApply()}
                  title="Apply all recommended settings"
                >
                  <span class="codicon codicon-check-all"></span>
                  Apply All
                </button>
              </div>
            `
          : nothing}
        ${this.renderDependencies()}
        ${this.desktopHost
          ? nothing
          : html`
              <div
                class="section-header"
                style="margin-top:var(--spacing-large)"
              >
                <span class="codicon codicon-settings-gear"></span>
                Recommended Settings
              </div>

              <div class="latex-description">
                Agents create temporary files during compilation. The following
                VS Code settings are recommended to keep your workspace tidy and
                avoid distracting sidebar activity.
              </div>

              ${RECOMMENDED_SETTINGS.map((info) =>
                this.renderSettingCard(info),
              )}
            `}
        ${this.renderInlineCriticismSetting()}
        ${this.renderCompileDiffSettings()}
      </div>
    `;
  }

  private renderInlineCriticismSetting(): TemplateResult {
    return html`
      <div class="section-header" style="margin-top:var(--spacing-large)">
        <span class="codicon codicon-comment-discussion"></span>
        Inline Criticism
      </div>
      <div class="setting-card">
        <span
          class="codicon setting-status-icon ${this.inlineCriticismEnabled
            ? 'is-set codicon-check'
            : 'not-set codicon-circle-slash'}"
        ></span>
        <div class="setting-info">
          <div class="setting-name">Surface \\criticize annotations</div>
          <div class="setting-description">
            Parse \\criticize{message}{severity}{confidence} annotations from
            agent-revised LaTeX files and show them as editor diagnostics.
          </div>
        </div>
        <label class="setting-toggle">
          <input
            type="checkbox"
            .checked=${this.inlineCriticismEnabled}
            @change=${this.handleInlineCriticismToggle}
          />
          <span>${this.inlineCriticismEnabled ? 'On' : 'Off'}</span>
        </label>
      </div>
    `;
  }

  // ── Compile & Diff settings (TeXRA storage-backed) ──

  private dispatchSetConfigValue<F extends LatexConfigField>(
    field: F,
    value: LatexConfigValueFor<F> | undefined,
  ): void {
    this.dispatchEvent(
      createEvent('latex-set-config-value', {
        field,
        value,
      }),
    );
  }

  private renderCompileDiffSettings(): TemplateResult {
    const cv = this.configValues;
    return html`
      <div class="section-header" style="margin-top:var(--spacing-large)">
        <span class="codicon codicon-zap"></span>
        Compile &amp; Diff
      </div>
      <div class="latex-description">
        TeXRA-specific compile and diff behavior, persisted per workspace. These
        were previously edited in <code>settings.json</code>; they now live
        here.
      </div>

      ${this.renderBooleanSetting({
        field: 'workflowAutoCompile',
        label: 'Auto-compile after each round',
        description:
          'After a workflow writes .tex outputs, attempt to compile each root document (latexmk, falling back to pdflatex) in run storage.',
        defaultValue: LATEX_CONFIG_DEFAULTS.workflowAutoCompile,
        currentValue: cv.workflowAutoCompile,
      })}
      ${this.renderNumberSetting({
        field: 'workflowAutoCompileTimeoutMs',
        label: 'Auto-compile timeout (ms)',
        description: `Per-file timeout for the post-workflow compile check. Minimum ${LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min}.`,
        defaultValue: LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs,
        currentValue: cv.workflowAutoCompileTimeoutMs,
        min: LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min,
      })}
      ${this.renderBooleanSetting({
        field: 'latexdiffBetweenRounds',
        label: 'Generate diffs between consecutive rounds',
        description:
          'In addition to comparing each round to the original input, also generate diffs between consecutive agent rounds.',
        defaultValue: LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds,
        currentValue: cv.latexdiffBetweenRounds,
      })}
      ${this.renderNumberSetting({
        field: 'latexdiffTimeoutMs',
        label: 'latexdiff timeout (ms)',
        description: `Timeout for latexdiff invocations. Range ${LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min}–${LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max}.`,
        defaultValue: LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs,
        currentValue: cv.latexdiffTimeoutMs,
        min: LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min,
        max: LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max,
      })}
      ${this.renderEnumSetting({
        field: 'latexdiffMathMarkup',
        label: 'latexdiff math markup',
        description: 'Granularity of markup in displayed math environments.',
        defaultValue: LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup,
        currentValue: cv.latexdiffMathMarkup,
        options: [
          { value: 'off', label: 'off — suppress markup' },
          { value: 'whole', label: 'whole — equation-level' },
          { value: 'coarse', label: 'coarse — within equations (default)' },
          { value: 'fine', label: 'fine — small changes inside equations' },
        ],
      })}
      ${this.renderEnumSetting({
        field: 'latexFormatter',
        label: 'LaTeX formatter',
        description:
          '"none" disables formatting; "latexindent" requires Perl; "tex-fmt" is a Rust-based alternative.',
        defaultValue: LATEX_CONFIG_DEFAULTS.latexFormatter,
        currentValue: cv.latexFormatter,
        options: [
          { value: 'latexindent', label: 'latexindent (default)' },
          { value: 'tex-fmt', label: 'tex-fmt' },
          { value: 'none', label: 'none' },
        ],
      })}
    `;
  }

  private renderBooleanSetting(opts: {
    field: 'workflowAutoCompile' | 'latexdiffBetweenRounds';
    label: string;
    description: string;
    defaultValue: boolean;
    currentValue: boolean | undefined;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const isCustom = opts.currentValue !== undefined;
    return html`
      <div class="setting-card">
        <span
          class="codicon setting-status-icon ${effective
            ? 'is-set codicon-check'
            : 'not-set codicon-circle-slash'}"
        ></span>
        <div class="setting-info">
          <div class="setting-name">${opts.label}</div>
          <div class="setting-description">${opts.description}</div>
        </div>
        <button
          class="tab-action-btn"
          @click=${() => this.dispatchSetConfigValue(opts.field, !effective)}
          title="Toggle"
        >
          ${effective ? 'On' : 'Off'}
        </button>
        ${isCustom
          ? html`<button
              class="tab-action-btn"
              @click=${() => this.dispatchSetConfigValue(opts.field, undefined)}
              title="Reset to default (${opts.defaultValue ? 'On' : 'Off'})"
            >
              <span class="codicon codicon-discard"></span>
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderNumberSetting(opts: {
    field: 'workflowAutoCompileTimeoutMs' | 'latexdiffTimeoutMs';
    label: string;
    description: string;
    defaultValue: number;
    currentValue: number | undefined;
    min: number;
    max?: number;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const isCustom = opts.currentValue !== undefined;
    return html`
      <div class="setting-card">
        <span
          class="codicon setting-status-icon ${isCustom
            ? 'is-set codicon-edit'
            : 'not-set codicon-circle-outline'}"
        ></span>
        <div class="setting-info">
          <div class="setting-name">${opts.label}</div>
          <div class="setting-description">${opts.description}</div>
          <input
            type="number"
            min=${opts.min}
            max=${opts.max ?? ''}
            .value=${String(effective)}
            @change=${(e: Event) => {
              const raw = (e.target as HTMLInputElement).valueAsNumber;
              if (Number.isNaN(raw)) return;
              // Coerce to integer first — paste / spinner can produce decimals
              // that the backend `.int()` schema would silently reject.
              const integer = Math.round(raw);
              const clamped = Math.max(
                opts.min,
                opts.max !== undefined ? Math.min(opts.max, integer) : integer,
              );
              this.dispatchSetConfigValue(opts.field, clamped);
            }}
            style="margin-top:var(--spacing-small);width:140px;"
          />
        </div>
        ${isCustom
          ? html`<button
              class="tab-action-btn"
              @click=${() => this.dispatchSetConfigValue(opts.field, undefined)}
              title="Reset to default (${opts.defaultValue})"
            >
              <span class="codicon codicon-discard"></span>
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderEnumSetting<
    F extends 'latexdiffMathMarkup' | 'latexFormatter',
  >(opts: {
    field: F;
    label: string;
    description: string;
    defaultValue: LatexConfigValueFor<F>;
    currentValue: LatexConfigValueFor<F> | undefined;
    options: Array<{ value: LatexConfigValueFor<F>; label: string }>;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const isCustom = opts.currentValue !== undefined;
    return html`
      <div class="setting-card">
        <span
          class="codicon setting-status-icon ${isCustom
            ? 'is-set codicon-edit'
            : 'not-set codicon-circle-outline'}"
        ></span>
        <div class="setting-info">
          <div class="setting-name">${opts.label}</div>
          <div class="setting-description">${opts.description}</div>
          <select
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement)
                .value as LatexConfigValueFor<F>;
              this.dispatchSetConfigValue(opts.field, v);
            }}
            style="margin-top:var(--spacing-small);"
          >
            ${opts.options.map(
              (o) => html`
                <option value=${o.value} ?selected=${o.value === effective}>
                  ${o.label}
                </option>
              `,
            )}
          </select>
        </div>
        ${isCustom
          ? html`<button
              class="tab-action-btn"
              @click=${() => this.dispatchSetConfigValue(opts.field, undefined)}
              title="Reset to default (${opts.defaultValue})"
            >
              <span class="codicon codicon-discard"></span>
            </button>`
          : nothing}
      </div>
    `;
  }
}

type LatexConfigField = keyof LatexConfigValues;
type LatexConfigValueFor<F extends LatexConfigField> = NonNullable<
  LatexConfigValues[F]
>;

declare global {
  interface HTMLElementTagNameMap {
    'latex-tab': LaTeXTab;
  }
}

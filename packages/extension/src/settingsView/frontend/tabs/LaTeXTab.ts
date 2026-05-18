/** Recommended LaTeX VS Code settings, dependency status, and TeXRA compile/diff options. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Web Awesome icon + spinner bundles (side-effect imports)
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';

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
  type OSPlatform,
} from '@shared/constants/latex';

// Local imports - shared utilities
import { copyTextToClipboard } from '@shared/utils/clipboard';
import { createEvent } from '@shared/utils/events';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

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
  readonly installGuide?: Record<OSPlatform, string>;
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
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .latex-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--wa-space-s);
      }

      .latex-title {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
      }

      .latex-description {
        margin-bottom: var(--wa-space-s);
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        line-height: var(--line-height-relaxed);
      }

      /* Shared card chrome for dependency + setting rows */
      .dependency-card,
      .setting-card {
        padding: var(--wa-space-xs);
        margin-bottom: var(--wa-space-xs);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        background: var(--wa-color-surface-default);
      }

      .setting-card {
        display: flex;
        align-items: flex-start;
        gap: var(--wa-space-xs);
      }

      .dependency-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
      }

      .dependency-icon,
      .setting-status-icon {
        flex-shrink: 0;
        font-size: var(--font-size-lg);
      }

      .setting-status-icon {
        margin-top: var(--wa-space-3xs);
      }

      .dependency-icon.installed,
      .setting-status-icon.is-set {
        color: var(--wa-color-testing-passed, #73c991);
      }

      .dependency-icon.missing,
      .setting-status-icon.not-set {
        color: var(--wa-color-testing-failed, #f48771);
      }

      /* Using-default state for non-boolean settings (number/enum). Not a
         problem — just hasn't been overridden. Render neutral, not red. */
      .setting-status-icon.is-default {
        color: var(--color-text-secondary);
      }

      .dependency-info {
        flex: 1;
        min-width: 0;
      }

      .dependency-name {
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
      }

      .dependency-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-top: var(--wa-space-3xs);
      }

      .dependency-guide-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) 0;
        margin-top: var(--wa-space-2xs);
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--wa-color-text-link, #3794ff);
        background: none;
        border: none;
        cursor: pointer;
      }

      .dependency-guide {
        margin-top: var(--wa-space-2xs);
        padding: var(--wa-space-xs);
        background: var(--wa-color-surface-lowered, rgba(128, 128, 128, 0.08));
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        line-height: var(--line-height-relaxed);
        white-space: pre-wrap;
      }

      .dependency-path {
        margin-top: var(--wa-space-3xs);
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }

      .dependency-install-actions {
        display: flex;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
      }

      .install-command-text {
        flex: 1;
        min-width: 0;
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        background: var(--wa-color-surface-lowered, rgba(128, 128, 128, 0.08));
        border-radius: var(--border-radius-small);
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .copy-success {
        color: var(--wa-color-testing-passed, #73c991) !important;
        border-color: var(--wa-color-testing-passed, #73c991) !important;
      }

      /* Prerequisite hint uses wa-callout; only layout for actions row + the
         inline command text live here. */
      wa-callout.prerequisite-hint {
        margin-bottom: var(--wa-space-xs);
        --padding: var(--wa-space-xs);
      }

      .hint-title {
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
        margin-bottom: var(--wa-space-3xs);
      }

      .hint-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
      }

      .hint-actions {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
      }

      /* .section-header chrome lives in commonViewStyles. */

      .setting-info {
        flex: 1;
        min-width: 0;
      }

      .setting-name {
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-normal);
        margin-bottom: var(--wa-space-3xs);
      }

      .setting-config-key {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--wa-space-2xs);
      }

      .setting-value {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-link);
      }

      .setting-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: var(--line-height-normal);
        margin-top: var(--wa-space-2xs);
      }

      wa-tag.setting-badge {
        flex-shrink: 0;
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
  /** Command string most recently copied; clears after a brief flash. */
  @state() private copiedCommand: string | null = null;
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback(): void {
    if (this.copyResetTimer) {
      clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    super.disconnectedCallback();
  }

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
        enabled: Boolean((event.target as WaSwitch | null)?.checked),
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
    const platform = this.settings.platform as OSPlatform;
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

  private async handleCopyCommand(command: string): Promise<void> {
    const ok = await copyTextToClipboard(command);
    if (!ok) return;
    this.copiedCommand = command;
    if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
    this.copyResetTimer = setTimeout(() => {
      this.copiedCommand = null;
      this.copyResetTimer = null;
    }, 2000);
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
    const platform = this.settings.platform as OSPlatform;
    const guideText = dep.installGuide?.[platform] ?? dep.installGuide?.linux;
    const detectedPaths = installed ? this.getDetectedPaths(dep) : [];
    const installCmd = !installed ? this.getInstallCommand(dep) : null;

    return html`
      <div class="dependency-card">
        <div class="dependency-row">
          <wa-icon
            library="texra"
            name=${installed ? 'check' : 'warning'}
            class="dependency-icon ${installed ? 'installed' : 'missing'}"
          ></wa-icon>
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
            ? nothing
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
                    <wa-icon library="texra" name="cloud-download"></wa-icon>
                    ${dep.actionLabel ?? 'Install'}
                  </button>
                `
              : html`<wa-tag
                  class="setting-badge"
                  variant="neutral"
                  size="small"
                  >Not found</wa-tag
                >`}
        </div>
        ${!installed && installCmd
          ? html`
              <div class="dependency-install-actions">
                <button
                  class="tab-action-btn ${this.copiedCommand ===
                  installCmd.command
                    ? 'copy-success'
                    : ''}"
                  title=${this.copiedCommand === installCmd.command
                    ? 'Copied!'
                    : `Copy: ${installCmd.command}`}
                  @click=${() => this.handleCopyCommand(installCmd.command)}
                >
                  <wa-icon library="texra" name="copy"></wa-icon>
                  Copy
                </button>
                <button
                  class="tab-action-btn"
                  title="Run: ${installCmd.command}"
                  @click=${() => this.handleRunInTerminal(installCmd.command)}
                >
                  <wa-icon library="texra" name="terminal"></wa-icon>
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
                <wa-icon
                  library="texra"
                  name=${expanded ? 'chevron-down' : 'chevron-right'}
                ></wa-icon>
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
    const platform = this.settings.platform as OSPlatform;
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
      <wa-callout class="prerequisite-hint" variant="brand">
        <wa-icon library="texra" name="info" slot="icon"></wa-icon>
        <div class="hint-title">${title}</div>
        <div class="hint-description">${description}</div>
        <div class="hint-actions">
          <code class="install-command-text">${installCommand}</code>
          <button
            class="tab-action-btn ${this.copiedCommand === installCommand
              ? 'copy-success'
              : ''}"
            title=${this.copiedCommand === installCommand
              ? 'Copied!'
              : `Copy ${pmName} install command`}
            @click=${() => this.handleCopyCommand(installCommand)}
          >
            <wa-icon library="texra" name="copy"></wa-icon>
            Copy
          </button>
          <button
            class="tab-action-btn"
            title=${this.desktopHost
              ? `Run ${pmName} installer`
              : `Run ${pmName} installer in VS Code terminal`}
            @click=${() => this.handleRunInTerminal(installCommand)}
          >
            <wa-icon library="texra" name="terminal"></wa-icon>
            Run in Terminal
          </button>
        </div>
      </wa-callout>
    `;
  }

  private renderDependencies(): TemplateResult {
    const dependencies = this.desktopHost
      ? DEPENDENCIES.filter((dep) => dep.key !== 'latexWorkshopInstalled')
      : DEPENDENCIES;

    return html`
      <div class="section-header">
        <wa-icon library="texra" name="package"></wa-icon>
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
        <wa-icon
          library="texra"
          name=${isSet ? 'check' : 'warning'}
          class="setting-status-icon ${isSet ? 'is-set' : 'not-set'}"
        ></wa-icon>
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
                <wa-icon library="texra" name="discard"></wa-icon>
                Reset
              </button>
            `
          : html`
              <button
                class="tab-action-btn"
                @click=${() => this.handleApply(info.key)}
                title="Apply this setting"
              >
                <wa-icon library="texra" name="check"></wa-icon>
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
            style="text-align:center;padding:var(--wa-space-s);color:var(--color-text-secondary)"
          >
            <wa-spinner></wa-spinner>
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
                  <wa-icon library="texra" name="check-all"></wa-icon>
                  Apply All
                </button>
              </div>
            `
          : nothing}
        ${this.renderDependencies()}
        ${this.desktopHost
          ? nothing
          : html`
              <div class="section-header" style="margin-top:var(--wa-space-s)">
                <wa-icon library="texra" name="settings-gear"></wa-icon>
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
      <div class="section-header" style="margin-top:var(--wa-space-s)">
        <wa-icon library="texra" name="comment-discussion"></wa-icon>
        Inline Criticism
      </div>
      <div class="setting-card">
        <wa-icon
          library="texra"
          name=${this.inlineCriticismEnabled ? 'check' : 'circle-slash'}
          class="setting-status-icon ${this.inlineCriticismEnabled
            ? 'is-set'
            : 'not-set'}"
        ></wa-icon>
        <div class="setting-info">
          <div class="setting-name">Surface \\criticize annotations</div>
          <div class="setting-description">
            Parse \\criticize{message}{severity}{confidence} annotations from
            agent-revised LaTeX files and show them as editor diagnostics.
          </div>
        </div>
        <wa-switch
          ?checked=${this.inlineCriticismEnabled}
          @change=${this.handleInlineCriticismToggle}
        >
          ${this.inlineCriticismEnabled ? 'On' : 'Off'}
        </wa-switch>
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
      <div class="section-header" style="margin-top:var(--wa-space-s)">
        <wa-icon library="texra" name="zap"></wa-icon>
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
        field: 'workflowAutoOpenPdf',
        label: 'Open compiled PDF or log',
        description:
          'After auto-compile finishes, open the latest PDF on success or the truncated LaTeX log on failure.',
        defaultValue: LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf,
        currentValue: cv.workflowAutoOpenPdf,
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
      ${this.renderBooleanSetting({
        field: 'latexdiffChangesOnly',
        label: 'Show only changed pages in latexdiff PDFs',
        description:
          'Pass latexdiff the ONLYCHANGEDPAGE subtype so compiled diff PDFs focus on pages with edits.',
        defaultValue: LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly,
        currentValue: cv.latexdiffChangesOnly,
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
    field:
      | 'workflowAutoCompile'
      | 'workflowAutoOpenPdf'
      | 'latexdiffBetweenRounds'
      | 'latexdiffChangesOnly';
    label: string;
    description: string;
    defaultValue: boolean;
    currentValue: boolean | undefined;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const isCustom = opts.currentValue !== undefined;
    return html`
      <div class="setting-card">
        <wa-icon
          library="texra"
          name=${effective ? 'check' : 'circle-slash'}
          class="setting-status-icon ${effective ? 'is-set' : 'not-set'}"
        ></wa-icon>
        <div class="setting-info">
          <div class="setting-name">${opts.label}</div>
          <div class="setting-description">${opts.description}</div>
        </div>
        <wa-switch
          ?checked=${effective}
          @change=${(e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            this.dispatchSetConfigValue(opts.field, checked);
          }}
          title="Toggle"
        ></wa-switch>
        ${isCustom
          ? html`<button
              class="tab-action-btn"
              @click=${() => this.dispatchSetConfigValue(opts.field, undefined)}
              title="Reset to default (${opts.defaultValue ? 'On' : 'Off'})"
            >
              <wa-icon library="texra" name="discard"></wa-icon>
            </button>`
          : nothing}
      </div>
    `;
  }

  /**
   * Icon for non-boolean settings (number/enum): an "edit" pencil when the
   * value has been customized, a neutral gear when it's still the default.
   * Red is reserved for booleans that are Off, where it carries meaning.
   */
  private renderSettingStatusIcon(isCustom: boolean): TemplateResult {
    return html`<wa-icon
      library="texra"
      name=${isCustom ? 'edit' : 'gear'}
      class="setting-status-icon ${isCustom ? 'is-set' : 'is-default'}"
      title=${isCustom ? 'Customized' : 'Using default'}
    ></wa-icon>`;
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
        ${this.renderSettingStatusIcon(isCustom)}
        <div class="setting-info">
          <div class="setting-name">${opts.label}</div>
          <div class="setting-description">${opts.description}</div>
          <wa-input
            type="number"
            min=${opts.min}
            max=${opts.max ?? nothing}
            .value=${String(effective)}
            @change=${(e: Event) => {
              const value = (e.target as WaInput).value;
              // Treat a cleared field as "no change" — `Number('')` would
              // silently coerce to 0/min and overwrite the saved value.
              if (typeof value !== 'string' || value.trim() === '') return;
              const raw = Number(value);
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
            style="margin-top:var(--wa-space-2xs);width:140px;"
          ></wa-input>
        </div>
        ${isCustom
          ? html`<button
              class="tab-action-btn"
              @click=${() => this.dispatchSetConfigValue(opts.field, undefined)}
              title="Reset to default (${opts.defaultValue})"
            >
              <wa-icon library="texra" name="discard"></wa-icon>
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
        ${this.renderSettingStatusIcon(isCustom)}
        <div class="setting-info">
          <div class="setting-name">${opts.label}</div>
          <div class="setting-description">${opts.description}</div>
          <wa-select
            .value=${String(effective)}
            @change=${(e: Event) => {
              const v = (e.target as WaSelect).value as LatexConfigValueFor<F>;
              this.dispatchSetConfigValue(opts.field, v);
            }}
            style="margin-top:var(--wa-space-2xs);"
          >
            ${opts.options.map(
              (o) => html`
                <wa-option value=${String(o.value)}>${o.label}</wa-option>
              `,
            )}
          </wa-select>
        </div>
        ${isCustom
          ? html`<button
              class="tab-action-btn"
              @click=${() => this.dispatchSetConfigValue(opts.field, undefined)}
              title="Reset to default (${opts.defaultValue})"
            >
              <wa-icon library="texra" name="discard"></wa-icon>
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

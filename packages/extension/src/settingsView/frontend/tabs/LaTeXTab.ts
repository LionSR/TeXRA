/** LaTeX settings page: dependencies, recommended VS Code settings, and the
 *  catalog-backed compile, diff, formatting, and review switches. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/copy-button/copy-button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  type LatexSettingsStatus,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/settingsView/settingsViewMessages';

// Local imports - LaTeX toolchain (install guides + commands)
import {
  PDFLATEX_INSTALL_GUIDE,
  LATEXDIFF_INSTALL_GUIDE,
  LATEXINDENT_INSTALL_GUIDE,
  TEXCOUNT_INSTALL_GUIDE,
  IMAGE_PROCESSING_INSTALL_GUIDE,
  DEPENDENCY_INSTALL_COMMANDS,
  hasInstallCommands,
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  type InstallCommand,
  type OSPlatform,
} from '@shared/constants/latexToolchain';

// Local imports - shared webview toolkit
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@ui/styles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderLoadingState } from '@ui/wa/loadingState';
import { renderSettingsBanner } from '@ui/wa/settingsBanner';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { renderSetStatusIcon, statusCheckIconStyles } from '@ui/wa/statusIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - shared utilities
import { filterNotNullish } from '@utils/core';

// Local imports - catalog-driven settings rows
import {
  renderStateSettingSelectRow,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import { latexTabStyles } from './LaTeXTab.styles';

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
  readonly actionCommand?: string;
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
    actionCommand: SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
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
    settingsBannerStyles,
    statusCheckIconStyles,
    latexTabStyles,
  ];

  @property({ attribute: false })
  settings: LatexSettingsStatus = { ...DEFAULT_LATEX_SETTINGS_STATUS };

  @property({ type: Boolean }) loaded = false;
  @property({ type: Boolean, attribute: 'desktop-host' }) desktopHost = false;

  // Catalog-backed values, one per row the page renders.
  @property({ type: Boolean }) autoCompile = true;
  @property({ type: Boolean }) autoOpenPdf = true;
  @property({ type: Boolean }) rejectOnCompileFailure = true;
  @property({ type: Boolean }) diffBetweenRounds = false;
  @property({ type: Boolean }) diffChangesOnly = true;
  @property() diffMathMarkup = 'coarse';
  @property() formatter = 'latexindent';
  @property({ type: Boolean }) inlineCriticismEnabled = false;

  private handleApply(field?: SettingInfo['key'], reset = false): void {
    postMessage(SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS, { field, reset });
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
    const platform = this.settings.platform;
    if (!hasInstallCommands(dep.key)) return null;
    const commands = DEPENDENCY_INSTALL_COMMANDS[dep.key];
    const options = commands[platform];
    if (!options?.length) return null;
    const pm = this.settings.packageManager;
    return (
      options.find((cmd) => !cmd.packageManager || cmd.packageManager === pm) ??
      null
    );
  }

  private handleRunInTerminal(command: string): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND, {
      installCommand: command,
    });
  }

  /** Collect detected tool paths for a dependency. */
  private getDetectedPaths(dep: DependencyInfo): string[] {
    if (!dep.pathKeys) return [];
    return dep.pathKeys.map((k) => this.settings[k]).filter(filterNotNullish);
  }

  private renderDependencyCard(dep: DependencyInfo): TemplateResult {
    const installed = this.settings[dep.key];
    const platform = this.settings.platform;
    const guideText = dep.installGuide?.[platform] ?? dep.installGuide?.linux;
    const detectedPaths = installed ? this.getDetectedPaths(dep) : [];
    const installCmd = !installed ? this.getInstallCommand(dep) : null;

    let actionSlot: TemplateResult | typeof nothing;
    if (installed) {
      actionSlot = nothing;
    } else if (dep.actionCommand) {
      actionSlot = html`
        <wa-button
          appearance="outlined"
          variant="neutral"
          size="s"
          title="${dep.actionLabel ?? 'Install'}"
          @click=${() => postMessage(dep.actionCommand!)}
        >
          ${waIcon('cloud-arrow-down', { slot: 'start' })}
          ${dep.actionLabel ?? 'Install'}
        </wa-button>
      `;
    } else {
      actionSlot = html`<wa-tag class="setting-badge" variant="neutral" size="s"
        >Not found</wa-tag
      >`;
    }

    return html`
      <div class="dependency-card">
        <div class="dependency-row">
          ${waIcon(installed ? 'check' : 'triangle-exclamation', {
            className: `dependency-icon ${installed ? 'installed' : 'missing'}`,
          })}
          <div class="dependency-info">
            <div class="dependency-name">${dep.name}</div>
            <div class="dependency-description">
              ${installed ? dep.installedDesc : dep.missingDesc}
            </div>
            ${detectedPaths.map(
              (p) =>
                html`<div class="dependency-path">
                  <bdi dir="auto">${p}</bdi>
                </div>`,
            )}
          </div>
          ${actionSlot}
        </div>
        ${
          !installed && installCmd
            ? html`
                <div class="dependency-install-actions">
                  <wa-copy-button
                    value=${installCmd.command}
                    copy-label="Copy install command"
                  ></wa-copy-button>
                  <wa-button
                    appearance="outlined"
                    variant="neutral"
                    size="s"
                    title="Run: ${installCmd.command}"
                    @click=${() => this.handleRunInTerminal(installCmd.command)}
                  >
                    ${waIcon('terminal', { slot: 'start' })} Run in Terminal
                  </wa-button>
                </div>
              `
            : nothing
        }
        ${
          !installed && guideText
            ? html`
                <wa-details
                  class="collapsible-quiet dependency-guide-details"
                  summary="Setup guide"
                >
                  <div class="dependency-guide">${guideText}</div>
                </wa-details>
              `
            : nothing
        }
      </div>
    `;
  }

  /**
   * Show a hint when the platform has a recommended package manager
   * that isn't installed yet (e.g. Homebrew on macOS, Scoop on Windows).
   */
  private renderPrerequisiteHint(): TemplateResult | typeof nothing {
    const platform = this.settings.platform;
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
    return renderSettingsBanner({
      id: `latex-${pmName.toLowerCase()}-prerequisite-banner`,
      className: 'prerequisite-hint',
      variant: 'brand',
      title,
      description,
      actions: html`
        <code class="install-command-text" dir="ltr">${installCommand}</code>
        <wa-copy-button
          value=${installCommand}
          copy-label="Copy install command"
        ></wa-copy-button>
        ${renderLabeledActionButton({
          icon: 'terminal',
          text: 'Run in Terminal',
          kind: 'secondary',
          appearance: 'outlined',
          title: this.desktopHost
            ? `Run ${pmName} installer`
            : `Run ${pmName} installer in VS Code terminal`,
          onClick: () => this.handleRunInTerminal(installCommand),
        })}
      `,
    });
  }

  private renderDependencies(): TemplateResult {
    const dependencies = this.desktopHost
      ? DEPENDENCIES.filter((dep) => dep.key !== 'latexWorkshopInstalled')
      : DEPENDENCIES;

    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Dependencies',
          description:
            'TeXRA checks the local tools used for compilation, diffs, formatting, and document analysis.',
          icon: 'box',
        })}
        ${this.renderPrerequisiteHint()}
        ${dependencies.map((dep) => this.renderDependencyCard(dep))}
      </div>
    `;
  }

  private renderSettingCard(info: SettingInfo): TemplateResult {
    const isSet = this.settings[info.key];
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${info.name}</span>
          <div class="setting-config-key">${info.configKey}</div>
          <div class="setting-value">${info.value}</div>
          <span class="settings-row-help">${info.description}</span>
        </div>
        <div class="settings-row-control">
          ${renderSetStatusIcon({
            status: isSet ? 'set' : 'not-set',
            title: 'Set',
            fallbacks: { 'not-set': { label: 'Not set' } },
          })}
          ${
            isSet
              ? renderLabeledActionButton({
                  icon: 'arrow-rotate-left',
                  text: 'Reset',
                  kind: 'secondary',
                  appearance: 'outlined',
                  title: 'Reset this setting to default',
                  onClick: () => this.handleApply(info.key, true),
                })
              : renderLabeledActionButton({
                  icon: 'check',
                  text: 'Apply',
                  kind: 'secondary',
                  appearance: 'outlined',
                  title: 'Apply this setting',
                  onClick: () => this.handleApply(info.key),
                })
          }
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.loaded) {
      return html`
        <div class="tab-content-container">
          ${renderLoadingState('Loading LaTeX settings…')}
        </div>
      `;
    }

    return html`
      <div class="tab-content-container">
        ${this.renderDependencies()}
        ${this.desktopHost ? nothing : this.renderRecommendedSettings()}
        ${this.renderCompileDiffSettings()} ${this.renderFormattingSettings()}
      </div>
    `;
  }

  private renderRecommendedSettings(): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Recommended VS Code settings',
          description:
            'Keep generated files out of the VS Code sidebar and reduce noise during agent runs.',
          icon: 'gear',
          actions: this.allSettingsSet()
            ? nothing
            : renderLabeledActionButton({
                icon: 'check-double',
                text: 'Apply all',
                kind: 'secondary',
                appearance: 'outlined',
                title: 'Apply all recommended settings',
                onClick: () => this.handleApply(),
              }),
        })}
        ${RECOMMENDED_SETTINGS.map((info) => this.renderSettingCard(info))}
      </div>
    `;
  }

  private renderCompileDiffSettings(): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Compile and diff',
          description:
            'What TeXRA does with the LaTeX an agent writes in this workspace.',
          icon: 'bolt',
        })}
        ${renderStateSettingToggleRow({
          key: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
          checked: this.autoCompile,
        })}
        ${renderStateSettingToggleRow({
          key: WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
          checked: this.autoOpenPdf,
          disabled: !this.autoCompile,
        })}
        ${renderStateSettingToggleRow({
          key: WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
          checked: this.rejectOnCompileFailure,
          disabled: !this.autoCompile,
        })}
        ${renderStateSettingToggleRow({
          key: WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
          checked: this.diffChangesOnly,
        })}
        ${renderStateSettingSelectRow({
          key: WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          value: this.diffMathMarkup,
        })}
        ${renderStateSettingToggleRow({
          key: WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
          checked: this.diffBetweenRounds,
        })}
      </div>
    `;
  }

  private renderFormattingSettings(): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Formatting and review',
          icon: 'wand-magic-sparkles',
        })}
        ${renderStateSettingSelectRow({
          key: WorkspaceStateKey.LATEX_FORMATTER,
          value: this.formatter,
        })}
        ${
          // Editor diagnostics are a VS Code surface; the desktop has none.
          this.desktopHost
            ? nothing
            : renderStateSettingToggleRow({
                key: GlobalStateKey.INLINE_CRITICISM_ENABLED,
                checked: this.inlineCriticismEnabled,
              })
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'latex-tab': LaTeXTab;
  }
}

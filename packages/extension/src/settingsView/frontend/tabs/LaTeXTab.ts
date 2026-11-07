/** LaTeX settings page, one section at a time: dependencies, compile and
 *  diff, formatting and review, and recommended VS Code settings. */

import { Predicate, Struct } from 'effect';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/copy-button/copy-button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { SignalWatcher } from '@lit-labs/signals';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import {
  type LatexSettingsStatus,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { SettingsSectionName } from '@texra/shared/settingsView/settingsTarget';

// Local imports - LaTeX toolchain (dependencies and their install advice)
import {
  HOMEBREW_INSTALL_COMMAND,
  installAdvice,
  LATEX_DEPENDENCIES,
  LATEX_RECOMMENDED_SETTINGS,
  LATEX_WORKSHOP_EXT_ID,
  type LatexDependency,
  type LatexRecommendedSettingField,
  SCOOP_INSTALL_COMMAND,
  type InstallAdvice,
} from '@texra/shared/constants/latexToolchain';

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

// Local imports - catalog-driven settings rows
import {
  renderStateSettingSelectRow,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import { settingSignal } from '../settingsState';
import { latexTabStyles } from './LaTeXTab.styles';
import {
  INLINE_CRITICISM_SETTING,
  LATEX_FORMATTER_SETTING,
} from '@texra/shared/settingsView/texraSettings';
import {
  LATEXDIFF_BETWEEN_ROUNDS_SETTING,
  LATEXDIFF_CHANGES_ONLY_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
  WORKFLOW_AUTO_COMPILE_SETTING,
  WORKFLOW_AUTO_OPEN_PDF_SETTING,
  WORKFLOW_REJECT_ON_COMPILE_FAILURE_SETTING,
} from '@texra/shared/settingsView/documentsSettings';

/** Path keys in LatexSettingsStatus for tool paths. */
type ToolPathKey = Extract<keyof LatexSettingsStatus, `${string}Path`>;

/** What the Dependencies section says of one dependency: the toolchain's
 *  dependencies, and LaTeX Workshop, which installs through a VS Code
 *  command instead. */
interface DependencyInfo {
  readonly key: LatexDependency | 'latexWorkshop';
  readonly installedDesc: string;
  readonly missingDesc: string;
  /** Keys to check for detected tool paths (shown when installed). */
  readonly pathKeys?: ToolPathKey[];
}

const DEPENDENCIES: DependencyInfo[] = [
  {
    key: 'compiler',
    installedDesc: 'pdflatex/latexmk detected on PATH.',
    missingDesc:
      'A TeX distribution (TeX Live, MacTeX, or MiKTeX) is required to compile LaTeX documents.',
    pathKeys: ['pdflatexPath', 'latexmkPath'],
  },
  {
    key: 'latexWorkshop',
    installedDesc: 'Provides LaTeX compilation, PDF preview, and IntelliSense.',
    missingDesc:
      'Required for LaTeX compilation, PDF preview, and IntelliSense.',
  },
  {
    key: 'latexdiff',
    installedDesc: 'Enables visual comparison of LaTeX document revisions.',
    missingDesc:
      'Install via your TeX distribution to enable diff comparisons.',
    pathKeys: ['latexdiffPath'],
  },
  {
    key: 'latexindent',
    installedDesc:
      'Used by agents to clean up formatting after editing your LaTeX source.',
    missingDesc:
      'Without it, agents may produce inconsistent indentation ' +
      'when editing .tex files. Requires Perl.',
    pathKeys: ['latexindentPath'],
  },
  {
    key: 'texcount',
    installedDesc:
      'Enables word, heading, and figure counting in LaTeX documents.',
    missingDesc:
      'Without it, agents cannot count words or structural elements in your .tex files. ' +
      'Part of most TeX Live distributions.',
    pathKeys: ['texcountPath'],
  },
  {
    key: 'image',
    installedDesc:
      'Ghostscript + GraphicsMagick/ImageMagick detected for PDF-to-PNG conversion.',
    missingDesc:
      'Needed to generate PNG previews of compiled PDF pages. ' +
      'Requires Ghostscript and either GraphicsMagick or ImageMagick.',
    pathKeys: ['ghostscriptPath', 'graphicsmagickPath'],
  },
];

@customElement('latex-tab')
export class LaTeXTab extends SignalWatcher(LitElement) {
  static override styles = [
    designTokens,
    commonViewStyles,
    settingsBannerStyles,
    statusCheckIconStyles,
    latexTabStyles,
  ];

  @property({ attribute: false })
  settings: LatexSettingsStatus = { ...DEFAULT_LATEX_SETTINGS_STATUS };

  @property({ attribute: false }) section: SettingsSectionName<'latex'> =
    'dependencies';
  @property({ type: Boolean }) loaded = false;

  private handleApply(
    field?: LatexRecommendedSettingField,
    reset = false,
  ): void {
    postMessage(SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS, { field, reset });
  }

  /** How to install `key` on this machine's platform. */
  private adviceFor(key: LatexDependency): InstallAdvice {
    const { label, installs } = LATEX_DEPENDENCIES[key];
    return installAdvice(label, installs, this.settings.platform);
  }

  private handleRunInTerminal(command: string): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND, {
      installCommand: command,
    });
  }

  /** Collect detected tool paths for a dependency. */
  private getDetectedPaths(dep: DependencyInfo): string[] {
    if (!dep.pathKeys) return [];
    return dep.pathKeys
      .map((k) => this.settings[k])
      .filter(Predicate.isNotNullish);
  }

  private renderDependencyCard(dep: DependencyInfo): TemplateResult {
    const { key } = dep;
    const workshop = key === 'latexWorkshop';
    const installed = workshop
      ? (this.settings.editor?.latexWorkshopInstalled ?? false)
      : this.settings.installed[key];
    const name = workshop ? 'LaTeX Workshop' : LATEX_DEPENDENCIES[key].label;
    const advice = workshop || installed ? null : this.adviceFor(key);
    const guideText = advice?.guide;
    const detectedPaths = installed ? this.getDetectedPaths(dep) : [];
    // The command shows once its package manager is detected.
    const installCmd =
      advice?.command?.packageManager === this.settings.packageManager
        ? advice.command
        : null;

    let actionSlot: TemplateResult | typeof nothing;
    if (installed) {
      actionSlot = nothing;
    } else if (workshop) {
      actionSlot = html`
        <wa-button
          appearance="outlined"
          variant="neutral"
          size="s"
          title="Install"
          @click=${() =>
            postMessage(SETTINGS_VIEW_COMMANDS.INSTALL_EXTENSION, {
              extensionId: LATEX_WORKSHOP_EXT_ID,
            })}
        >
          ${waIcon('cloud-arrow-down', { slot: 'start' })} Install
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
            <div class="dependency-name">${name}</div>
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
          installCmd
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
          guideText
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
          title: `Run ${pmName} installer in a terminal`,
          onClick: () => this.handleRunInTerminal(installCommand),
        })}
      `,
    });
  }

  private renderDependencies(): TemplateResult {
    // LaTeX Workshop is an editor extension: shown where there is an editor.
    const dependencies = this.settings.editor
      ? DEPENDENCIES
      : DEPENDENCIES.filter((dep) => dep.key !== 'latexWorkshop');

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

  private renderSettingCard(
    field: LatexRecommendedSettingField,
    isSet: boolean,
  ): TemplateResult {
    const info = LATEX_RECOMMENDED_SETTINGS[field];
    // HTML collapses the indent newlines: an object reads `{ "key": value }`.
    const value =
      info.kind === 'scalar' ? info.value : JSON.stringify(info.value, null, 1);
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${info.name}</span>
          <div class="setting-config-key">${info.key}</div>
          <div class="setting-value">${value}</div>
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
                  onClick: () => this.handleApply(field, true),
                })
              : renderLabeledActionButton({
                  icon: 'check',
                  text: 'Apply',
                  kind: 'secondary',
                  appearance: 'outlined',
                  title: 'Apply this setting',
                  onClick: () => this.handleApply(field),
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

    const sections = {
      dependencies: () => this.renderDependencies(),
      compile: () => this.renderCompileDiffSettings(),
      formatting: () => this.renderFormattingSettings(),
      vscode: () =>
        this.settings.editor
          ? this.renderRecommendedSettings(this.settings.editor.recommended)
          : nothing,
    };
    return html`
      <div class="tab-content-container">${sections[this.section]()}</div>
    `;
  }

  private renderRecommendedSettings(
    recommended: Readonly<Record<LatexRecommendedSettingField, boolean>>,
  ): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Recommended VS Code settings',
          description:
            'Keep generated files out of the VS Code sidebar and reduce noise during agent runs.',
          icon: 'gear',
          actions: Object.values(recommended).every(Boolean)
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
        ${Struct.keys(LATEX_RECOMMENDED_SETTINGS).map((field) =>
          this.renderSettingCard(field, recommended[field]),
        )}
      </div>
    `;
  }

  private renderCompileDiffSettings(): TemplateResult {
    const autoCompile = settingSignal(WORKFLOW_AUTO_COMPILE_SETTING).get();
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Compile and diff',
          description:
            'What TeXRA does with the LaTeX an agent writes in this workspace.',
          icon: 'bolt',
        })}
        ${renderStateSettingToggleRow(WORKFLOW_AUTO_COMPILE_SETTING)}
        ${renderStateSettingToggleRow(WORKFLOW_AUTO_OPEN_PDF_SETTING, {
          disabled: !autoCompile,
        })}
        ${renderStateSettingToggleRow(
          WORKFLOW_REJECT_ON_COMPILE_FAILURE_SETTING,
          { disabled: !autoCompile },
        )}
        ${renderStateSettingToggleRow(LATEXDIFF_CHANGES_ONLY_SETTING)}
        ${renderStateSettingSelectRow(LATEXDIFF_MATH_MARKUP_SETTING)}
        ${renderStateSettingToggleRow(LATEXDIFF_BETWEEN_ROUNDS_SETTING)}
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
        ${renderStateSettingSelectRow(LATEX_FORMATTER_SETTING)}
        ${
          // Inline criticism is an editor's diagnostics: shown where there is
          // an editor.
          this.settings.editor
            ? renderStateSettingToggleRow(INLINE_CRITICISM_SETTING)
            : nothing
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

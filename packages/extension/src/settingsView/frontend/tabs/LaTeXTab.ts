/** Recommended LaTeX VS Code settings, dependency status, and TeXRA compile/diff options. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/copy-button/copy-button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared webview
import {
  commonViewStyles,
  designTokens,
  settingsBannerStyles,
} from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  type LatexConfigValues,
  type LatexSettingsStatus,
  CoreSettingsShape,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderLoadingState } from '@shared/wa/loadingState';
import { renderSettingsBanner } from '@shared/wa/settingsBanner';
import {
  renderSettingsSectionHeading,
  renderSettingsToggleRow,
} from '@shared/wa/settingsSection';
import {
  renderSetStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Web Awesome button + icon bundles (side-effect imports)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - LaTeX config constants (shared with backend + readers)
import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
  type NonRegexReplacementCategory,
  type RegexReplacementCategory,
} from '@shared/constants/replacementCategories';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_FIELD_TO_KEY,
  LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY,
  LATEX_CONFIG_RANGES,
} from '@shared/constants/latexConfig';

// Local imports - LaTeX toolchain (install guides + commands)
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
} from '@shared/constants/latexToolchain';

// Local imports - shared utilities
import { clampOptional, filterNotNullish } from '@utils/core';

// Local imports - catalog-driven settings rows
import {
  catalogEnumChoices,
  postStateSetting,
} from '../components/shared/stateSettingRows';
import { latexTabStyles } from './LaTeXTab.styles';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import type WaTextarea from '@awesome.me/webawesome/dist/components/textarea/textarea.js';

const LATEX_CONFIG_FIELD_TO_KEY = {
  ...LATEX_FIELD_TO_KEY,
  ...LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY,
} as const satisfies Record<keyof LatexConfigValues, string>;

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

  @property({ attribute: false })
  configValues: LatexConfigValues = {};

  @property({ type: Boolean, attribute: 'config-loaded' }) configLoaded = false;
  @property({ type: Boolean }) inlineCriticismEnabled = false;
  @property({ type: Boolean, attribute: 'desktop-host' }) desktopHost = false;

  /**
   * Whether the active host's registry supports the inline-criticism
   * commands (`GET_INLINE_CRITICISM_ENABLED`) — derived via
   * `isKnownUnsupported` in `SettingsApp`, not the raw `desktopHost` flag,
   * since this is command availability rather than host-specific UI
   * (unlike the VS Code settings.json sections below, which genuinely don't
   * exist on desktop and stay gated on `desktopHost`).
   */
  @property({ type: Boolean }) inlineCriticismSupported = false;

  @state()
  private replacementJsonErrors: Partial<
    Record<'customReplacements' | 'customReplacementsRegex', string>
  > = {};

  private handleApply(field?: SettingInfo['key'], reset = false): void {
    postMessage(SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS, { field, reset });
  }

  private handleInlineCriticismToggle(event: Event): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_INLINE_CRITICISM_ENABLED, {
      enabled: Boolean((event.target as WaSwitch | null)?.checked),
    });
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
              (p) => html`<div class="dependency-path">${p}</div>`,
            )}
          </div>
          ${actionSlot}
        </div>
        ${
          !installed && installCmd
            ? html`
                <div class="dependency-install-actions">
                  <wa-copy-button value=${installCmd.command}></wa-copy-button>
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
        <code class="install-command-text">${installCommand}</code>
        <wa-copy-button value=${installCommand}></wa-copy-button>
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
        ${
          !this.desktopHost && !this.allSettingsSet()
            ? html`
                <div class="latex-header">
                  <wa-button
                    appearance="outlined"
                    variant="neutral"
                    size="s"
                    title="Apply all recommended settings"
                    @click=${() => this.handleApply()}
                  >
                    ${waIcon('check-double', { slot: 'start' })} Apply All
                  </wa-button>
                </div>
              `
            : nothing
        }
        ${this.renderDependencies()}
        ${
          this.desktopHost
            ? nothing
            : html`
                <div class="settings-section">
                  ${renderSettingsSectionHeading({
                    title: 'Recommended settings',
                    description:
                      'Keep generated files out of the VS Code sidebar and reduce noise during agent runs.',
                    icon: 'gear',
                  })}
                  ${RECOMMENDED_SETTINGS.map((info) =>
                    this.renderSettingCard(info),
                  )}
                </div>
              `
        }
        ${
          this.inlineCriticismSupported
            ? this.renderInlineCriticismSetting()
            : nothing
        }
        ${this.renderReplacementSettings()} ${this.renderCompileDiffSettings()}
      </div>
    `;
  }

  private renderInlineCriticismSetting(): TemplateResult {
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Inline criticism',
          description:
            'Control how TeXRA surfaces structured review annotations in LaTeX documents.',
          icon: 'comments',
        })}
        ${renderSettingsToggleRow({
          label: 'Surface \\criticize annotations',
          description:
            'Parse \\criticize{message}{severity}{confidence} annotations from agent-revised LaTeX files and show them as editor diagnostics.',
          checked: this.inlineCriticismEnabled,
          onChange: this.handleInlineCriticismToggle,
        })}
      </div>
    `;
  }

  // ── Compile & Diff settings (TeXRA storage-backed) ──

  private renderReplacementSettings(): TemplateResult {
    const cv = this.configValues;
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Replacement engine',
          description:
            'Choose the cleanup rules applied to LaTeX text and define project-specific replacements.',
          icon: 'wand-magic-sparkles',
        })}
        ${this.renderBooleanSetting({
          field: 'wrapCritiqueInAlign',
          label: 'Protect criticism inside align environments',
          description:
            'Wrap bare \\critique and \\comment commands with \\intertext so align environments remain valid.',
          defaultValue: true,
          currentValue: cv.wrapCritiqueInAlign,
        })}
        ${this.renderReplacementCategories({
          field: 'enabledReplacements',
          label: 'Direct replacement groups',
          description:
            'Cleanup groups that replace exact LaTeX text and characters.',
          categories: NON_REGEX_REPLACEMENT_CATEGORIES,
          defaultValue: DEFAULT_ENABLED_REPLACEMENTS,
          currentValue: cv.enabledReplacements,
        })}
        ${this.renderReplacementCategories({
          field: 'enabledReplacementsRegex',
          label: 'Pattern replacement groups',
          description:
            'Cleanup groups that recognize LaTeX structures and surrounding context.',
          categories: REGEX_REPLACEMENT_CATEGORIES,
          defaultValue: DEFAULT_ENABLED_REGEX_REPLACEMENTS,
          currentValue: cv.enabledReplacementsRegex,
        })}
        ${this.renderCustomReplacementSetting({
          field: 'customReplacements',
          label: 'Custom direct replacements',
          description:
            'A JSON object whose keys are exact source text and whose values are replacements.',
          currentValue: cv.customReplacements,
        })}
        ${this.renderCustomReplacementSetting({
          field: 'customReplacementsRegex',
          label: 'Custom pattern replacements',
          description:
            'A JSON object whose keys are regular expressions and whose values may use $1, $2, and later capture groups.',
          currentValue: cv.customReplacementsRegex,
        })}
      </div>
    `;
  }

  private renderReplacementCategories<
    F extends 'enabledReplacements' | 'enabledReplacementsRegex',
    C extends NonRegexReplacementCategory | RegexReplacementCategory,
  >(opts: {
    field: F;
    label: string;
    description: string;
    categories: readonly C[];
    defaultValue: readonly C[];
    currentValue: C[] | undefined;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const enabled = new Set(effective);
    const isCustom =
      effective.length !== opts.defaultValue.length ||
      effective.some((value, index) => value !== opts.defaultValue[index]);
    return html`
      <div class="settings-row replacement-groups-row">
        <div class="settings-row-text">
          <span class="settings-row-label">${opts.label}</span>
          <span class="settings-row-help">${opts.description}</span>
          <div class="replacement-category-grid">
            ${opts.categories.map(
              (category) => html`
                <wa-checkbox
                  ?checked=${enabled.has(category)}
                  @change=${(event: Event) => {
                    const next = new Set(effective);
                    if ((event.target as WaCheckbox).checked) {
                      next.add(category);
                    } else {
                      next.delete(category);
                    }
                    this.dispatchSetConfigValue(
                      opts.field,
                      opts.categories.filter((item) =>
                        next.has(item),
                      ) as LatexConfigValueFor<F>,
                    );
                  }}
                  >${category.replaceAll('_', ' ')}</wa-checkbox
                >
              `,
            )}
          </div>
        </div>
        <div class="settings-row-control">
          ${this.renderSettingStatusIcon(isCustom)}
          ${
            isCustom
              ? this.renderResetButton(opts.field, 'release defaults')
              : nothing
          }
        </div>
      </div>
    `;
  }

  private renderCustomReplacementSetting(opts: {
    field: 'customReplacements' | 'customReplacementsRegex';
    label: string;
    description: string;
    currentValue: Record<string, string> | undefined;
  }): TemplateResult {
    const value = opts.currentValue ?? {};
    const isCustom = Object.keys(value).length > 0;
    const error = this.replacementJsonErrors[opts.field];
    const controlId = `latex-setting-${opts.field}`;
    return html`
      <div class="settings-row replacement-map-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${controlId}
            >${opts.label}</label
          >
          <span class="settings-row-help">${opts.description}</span>
          <wa-textarea
            id=${controlId}
            rows="4"
            resize="auto"
            spellcheck="false"
            .value=${JSON.stringify(value, null, 2)}
            @change=${(event: Event) =>
              this.handleCustomReplacementChange(
                opts.field,
                (event.target as WaTextarea).value ?? '',
              )}
          ></wa-textarea>
          ${
            error
              ? html`<span class="replacement-json-error">${error}</span>`
              : nothing
          }
        </div>
        <div class="settings-row-control">
          ${this.renderSettingStatusIcon(isCustom)}
          ${isCustom ? this.renderResetButton(opts.field, '{}') : nothing}
        </div>
      </div>
    `;
  }

  private handleCustomReplacementChange(
    field: 'customReplacements' | 'customReplacementsRegex',
    source: string,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      this.replacementJsonErrors = {
        ...this.replacementJsonErrors,
        [field]: error instanceof Error ? error.message : 'Invalid JSON.',
      };
      return;
    }
    const result = CoreSettingsShape.latex
      .unwrap()
      .shape[field].safeParse(parsed);
    if (!result.success) {
      this.replacementJsonErrors = {
        ...this.replacementJsonErrors,
        [field]: 'Enter a JSON object with string values.',
      };
      return;
    }
    this.replacementJsonErrors = {
      ...this.replacementJsonErrors,
      [field]: undefined,
    };
    this.dispatchSetConfigValue(field, result.data);
  }

  private dispatchSetConfigValue<F extends LatexConfigField>(
    field: F,
    value: LatexConfigValueFor<F> | undefined,
  ): void {
    postStateSetting(LATEX_CONFIG_FIELD_TO_KEY[field], value ?? null);
  }

  private renderCompileDiffSettings(): TemplateResult {
    const cv = this.configValues;
    return html`
      <div class="settings-section">
        ${renderSettingsSectionHeading({
          title: 'Compile and diff',
          description:
            'Workspace-specific compilation, review, and formatting behavior.',
          icon: 'bolt',
        })}
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
          field: 'workflowRejectOnCompileFailure',
          label: 'Reject rounds when compile fails',
          description:
            'When a LaTeX compile check fails, use the next planned round to repair the output with the compile log.',
          defaultValue: LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure,
          currentValue: cv.workflowRejectOnCompileFailure,
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
          withDescription: true,
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
          withDescription: false,
        })}
      </div>
    `;
  }

  /** Shared row scaffold for the storage-backed compile and diff settings. */
  private renderConfigRow(opts: {
    label: string;
    description: string;
    /** Control id the row's `<label for>` points at; the control template
     *  must carry the same id. A real `<label for>` is used because a host
     *  aria-label on WA form-associated elements names the custom element,
     *  not the inner control (see settingsSection.ts). */
    controlId: string;
    statusIcon?: TemplateResult | typeof nothing;
    control: TemplateResult;
    reset: TemplateResult | typeof nothing;
  }): TemplateResult {
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${opts.controlId}
            >${opts.label}</label
          >
          <span class="settings-row-help">${opts.description}</span>
        </div>
        <div class="settings-row-control">
          ${opts.statusIcon ?? nothing} ${opts.control} ${opts.reset}
        </div>
      </div>
    `;
  }

  private renderBooleanSetting(opts: {
    field:
      | 'workflowAutoCompile'
      | 'workflowAutoOpenPdf'
      | 'workflowRejectOnCompileFailure'
      | 'latexdiffBetweenRounds'
      | 'latexdiffChangesOnly'
      | 'wrapCritiqueInAlign';
    label: string;
    description: string;
    defaultValue: boolean;
    currentValue: boolean | undefined;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const isCustom = effective !== opts.defaultValue;
    // No status icon: the switch already carries the on/off state, matching
    // the toggle rows in the other settings tabs.
    const controlId = `latex-setting-${opts.field}`;
    return this.renderConfigRow({
      label: opts.label,
      description: opts.description,
      controlId,
      control: html`
        <wa-switch
          id=${controlId}
          ?checked=${effective}
          @change=${(e: Event) => {
            const checked = (e.target as WaSwitch).checked;
            this.dispatchSetConfigValue(opts.field, checked);
          }}
        ></wa-switch>
      `,
      reset: isCustom
        ? this.renderResetButton(opts.field, opts.defaultValue ? 'On' : 'Off')
        : nothing,
    });
  }

  /**
   * Icon for non-boolean settings (number/enum): an "edit" pencil when the
   * value has been customized, a neutral gear when it's still the default.
   * Boolean rows carry their state on the switch itself, so they render no
   * status icon.
   */
  private renderSettingStatusIcon(isCustom: boolean): TemplateResult {
    // `label` (not just `title`) so the state reaches assistive technology —
    // a titled but aria-hidden icon is visual-only.
    return waIcon(isCustom ? 'pencil' : 'gear', {
      className: `setting-status-icon ${isCustom ? 'is-set' : 'is-default'}`,
      label: isCustom ? 'Customized' : 'Using default',
      title: isCustom ? 'Customized' : 'Using default',
    });
  }

  /** Reset-to-default button shown when a config value has been customized. */
  private renderResetButton(
    field: LatexConfigField,
    defaultDisplay: string,
  ): TemplateResult {
    return renderLabeledActionButton({
      icon: 'arrow-rotate-left',
      text: 'Reset',
      kind: 'secondary',
      appearance: 'outlined',
      label: 'Reset to default',
      title: `Reset to default (${defaultDisplay})`,
      onClick: () => this.dispatchSetConfigValue(field, undefined),
    });
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
    const isCustom = effective !== opts.defaultValue;
    const controlId = `latex-setting-${opts.field}`;
    return this.renderConfigRow({
      label: opts.label,
      description: opts.description,
      statusIcon: this.renderSettingStatusIcon(isCustom),
      controlId,
      control: html`
        <wa-input
          id=${controlId}
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
            const clamped = clampOptional(integer, opts.min, opts.max);
            this.dispatchSetConfigValue(opts.field, clamped);
          }}
          class="setting-number-input"
        ></wa-input>
      `,
      reset: isCustom
        ? this.renderResetButton(opts.field, String(opts.defaultValue))
        : nothing,
    });
  }

  /**
   * Enum row whose allowed values come from the shared `stateSettings` catalog
   * entry for this field. The option label format stays this tab's own:
   * `value — description` when `withDescription`, bare `value` otherwise, with
   * ` (default)` appended to the default option.
   */
  private renderEnumSetting<
    F extends 'latexdiffMathMarkup' | 'latexFormatter',
  >(opts: {
    field: F;
    label: string;
    description: string;
    defaultValue: LatexConfigValueFor<F>;
    currentValue: LatexConfigValueFor<F> | undefined;
    withDescription: boolean;
  }): TemplateResult {
    const effective = opts.currentValue ?? opts.defaultValue;
    const isCustom = effective !== opts.defaultValue;
    const controlId = `latex-setting-${opts.field}`;
    const options = catalogEnumChoices<LatexConfigValueFor<F>>(
      LATEX_CONFIG_FIELD_TO_KEY[opts.field],
    ).map((choice) => {
      const base =
        opts.withDescription && choice.description
          ? `${choice.value} — ${choice.description}`
          : choice.value;
      return {
        value: choice.value,
        label: choice.value === opts.defaultValue ? `${base} (default)` : base,
      };
    });
    return this.renderConfigRow({
      label: opts.label,
      description: opts.description,
      statusIcon: this.renderSettingStatusIcon(isCustom),
      controlId,
      control: html`
        <wa-select
          id=${controlId}
          .value=${String(effective)}
          @change=${(e: Event) => {
            const v = (e.target as WaSelect).value as LatexConfigValueFor<F>;
            this.dispatchSetConfigValue(opts.field, v);
          }}
          class="setting-enum-select"
        >
          ${options.map(
            (o) =>
              html`<wa-option value=${String(o.value)}>${o.label}</wa-option>`,
          )}
        </wa-select>
      `,
      reset: isCustom
        ? this.renderResetButton(opts.field, String(opts.defaultValue))
        : nothing,
    });
  }
}

type LatexConfigField = keyof typeof LATEX_CONFIG_FIELD_TO_KEY;
type LatexConfigValueFor<F extends LatexConfigField> = NonNullable<
  LatexConfigValues[F]
>;

declare global {
  interface HTMLElementTagNameMap {
    'latex-tab': LaTeXTab;
  }
}

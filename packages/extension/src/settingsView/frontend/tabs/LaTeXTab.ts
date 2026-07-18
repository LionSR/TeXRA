/** Recommended LaTeX VS Code settings, dependency status, and TeXRA compile/diff options. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/copy-button/copy-button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared webview
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { renderLoadingState } from '@shared/wa/loadingState';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Web Awesome button + icon bundles (side-effect imports)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

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
  type LatexdiffMathMarkupValue,
  type LatexFormatterValue,
} from '@shared/constants/latex';

// Local imports - state-backed settings catalog (single source for enum options)
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  settingEnumOptions,
  stateSettingByKey,
} from '@shared/schemas/stateSettings';

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
import { clamp, filterNotNullish } from '@utils/core';
import { latexTabStyles } from './LaTeXTab.styles';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

/**
 * Build the `<wa-select>` option list for an enum setting from the shared
 * catalog so the allowed values + per-option text live in one place
 * (`stateSettings.ts`) rather than being hand-listed here. The label format
 * stays this tab's own: `value — description` for math markup, bare `value`
 * for the formatter, with ` (default)` appended to the default option.
 */
function catalogEnumOptions<T extends string>(
  key: string,
  defaultValue: T,
  withDescription: boolean,
): Array<{ value: T; label: string }> {
  const entry = stateSettingByKey(key);
  const values = entry ? (settingEnumOptions(entry) ?? []) : [];
  const descriptions = entry?.enumDescriptions ?? [];
  return values.map((value, index) => {
    const base =
      withDescription && descriptions[index]
        ? `${value} — ${descriptions[index]}`
        : value;
    const label = value === defaultValue ? `${base} (default)` : base;
    return { value: value as T, label };
  });
}

const LATEXDIFF_MATH_MARKUP_OPTIONS =
  catalogEnumOptions<LatexdiffMathMarkupValue>(
    WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
    LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup,
    true,
  );

const LATEX_FORMATTER_OPTIONS = catalogEnumOptions<LatexFormatterValue>(
  WorkspaceStateKey.LATEX_FORMATTER,
  LATEX_CONFIG_DEFAULTS.latexFormatter,
  false,
);

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
  static override styles = [designTokens, commonViewStyles, latexTabStyles];

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
          size="small"
          title="${dep.actionLabel ?? 'Install'}"
          @click=${() => postMessage(dep.actionCommand!)}
        >
          ${waIcon('cloud-download', { slot: 'start' })}
          ${dep.actionLabel ?? 'Install'}
        </wa-button>
      `;
    } else {
      actionSlot = html`<wa-tag
        class="setting-badge"
        variant="neutral"
        size="small"
        >Not found</wa-tag
      >`;
    }

    return html`
      <div class="dependency-card">
        <div class="dependency-row">
          ${waIcon(installed ? 'check' : 'warning', {
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
                    size="small"
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
                  summary="Installation Guide"
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
    return html`
      <wa-callout class="prerequisite-hint" variant="brand">
        ${waIcon('info', { slot: 'icon' })}
        <div class="hint-title">${title}</div>
        <div class="hint-description">${description}</div>
        <div class="hint-actions">
          <code class="install-command-text">${installCommand}</code>
          <wa-copy-button value=${installCommand}></wa-copy-button>
          <wa-button
            appearance="outlined"
            variant="neutral"
            size="small"
            title=${
              this.desktopHost
                ? `Run ${pmName} installer`
                : `Run ${pmName} installer in VS Code terminal`
            }
            @click=${() => this.handleRunInTerminal(installCommand)}
          >
            ${waIcon('terminal', { slot: 'start' })} Run in Terminal
          </wa-button>
        </div>
      </wa-callout>
    `;
  }

  private renderDependencies(): TemplateResult {
    const dependencies = this.desktopHost
      ? DEPENDENCIES.filter((dep) => dep.key !== 'latexWorkshopInstalled')
      : DEPENDENCIES;

    return html`
      <div class="section-header">${waIcon('package')} Dependencies</div>
      ${this.renderPrerequisiteHint()}
      ${dependencies.map((dep) => this.renderDependencyCard(dep))}
    `;
  }

  private renderSettingCard(info: SettingInfo): TemplateResult {
    const isSet = this.settings[info.key];
    return html`
      <div class="setting-card">
        ${waIcon(isSet ? 'check' : 'warning', {
          className: `setting-status-icon ${isSet ? 'is-set' : 'not-set'}`,
        })}
        <div class="setting-info">
          <div class="setting-name">${info.name}</div>
          <div class="setting-config-key">${info.configKey}</div>
          <div class="setting-value">${info.value}</div>
          <div class="setting-description">${info.description}</div>
        </div>
        ${
          isSet
            ? html`
                <wa-button
                  appearance="outlined"
                  variant="neutral"
                  size="small"
                  title="Reset this setting to default"
                  @click=${() => this.handleApply(info.key, true)}
                >
                  ${waIcon('discard', { slot: 'start' })} Reset
                </wa-button>
              `
            : html`
                <wa-button
                  appearance="outlined"
                  variant="neutral"
                  size="small"
                  title="Apply this setting"
                  @click=${() => this.handleApply(info.key)}
                >
                  ${waIcon('check', { slot: 'start' })} Apply
                </wa-button>
              `
        }
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.loaded) {
      return html`
        <div class="tab-content-container">
          ${renderLoadingState('Loading LaTeX settings...')}
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
                    size="small"
                    title="Apply all recommended settings"
                    @click=${() => this.handleApply()}
                  >
                    ${waIcon('check-all', { slot: 'start' })} Apply All
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
                <div class="section-header spaced">
                  ${waIcon('settings-gear')} Recommended Settings
                </div>

                <div class="latex-description">
                  Agents create temporary files during compilation. The
                  following VS Code settings are recommended to keep your
                  workspace tidy and avoid distracting sidebar activity.
                </div>

                ${RECOMMENDED_SETTINGS.map((info) =>
                  this.renderSettingCard(info),
                )}
              `
        }
        ${
          this.inlineCriticismSupported
            ? this.renderInlineCriticismSetting()
            : nothing
        }
        ${this.renderCompileDiffSettings()}
      </div>
    `;
  }

  private renderInlineCriticismSetting(): TemplateResult {
    return html`
      <div class="section-header spaced">
        ${waIcon('comment-discussion')} Inline Criticism
      </div>
      <div class="setting-card">
        ${waIcon(this.inlineCriticismEnabled ? 'check' : 'circle-slash', {
          className: `setting-status-icon ${
            this.inlineCriticismEnabled ? 'is-set' : 'not-set'
          }`,
        })}
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
    postMessage(SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE, {
      field,
      value,
    });
  }

  private renderCompileDiffSettings(): TemplateResult {
    const cv = this.configValues;
    return html`
      <div class="section-header spaced">
        ${waIcon('zap')} Compile &amp; Diff
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
        options: LATEXDIFF_MATH_MARKUP_OPTIONS,
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
        options: LATEX_FORMATTER_OPTIONS,
      })}
    `;
  }

  private renderBooleanSetting(opts: {
    field:
      | 'workflowAutoCompile'
      | 'workflowAutoOpenPdf'
      | 'workflowRejectOnCompileFailure'
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
        ${waIcon(effective ? 'check' : 'circle-slash', {
          className: `setting-status-icon ${effective ? 'is-set' : 'not-set'}`,
        })}
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
        ${
          isCustom
            ? this.renderResetButton(
                opts.field,
                opts.defaultValue ? 'On' : 'Off',
              )
            : nothing
        }
      </div>
    `;
  }

  /**
   * Icon for non-boolean settings (number/enum): an "edit" pencil when the
   * value has been customized, a neutral gear when it's still the default.
   * Red is reserved for booleans that are Off, where it carries meaning.
   */
  private renderSettingStatusIcon(isCustom: boolean): TemplateResult {
    return waIcon(isCustom ? 'edit' : 'gear', {
      className: `setting-status-icon ${isCustom ? 'is-set' : 'is-default'}`,
      title: isCustom ? 'Customized' : 'Using default',
    });
  }

  /** Reset-to-default button shown when a config value has been customized. */
  private renderResetButton(
    field: LatexConfigField,
    defaultDisplay: string,
  ): TemplateResult {
    return html`<wa-button
      appearance="outlined"
      variant="neutral"
      size="small"
      aria-label="Reset to default"
      title="Reset to default (${defaultDisplay})"
      @click=${() => this.dispatchSetConfigValue(field, undefined)}
    >
      ${waIcon('discard')}
    </wa-button>`;
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
              const clamped =
                opts.max !== undefined
                  ? clamp(integer, opts.min, opts.max)
                  : Math.max(opts.min, integer);
              this.dispatchSetConfigValue(opts.field, clamped);
            }}
            class="setting-number-input"
          ></wa-input>
        </div>
        ${
          isCustom
            ? this.renderResetButton(opts.field, String(opts.defaultValue))
            : nothing
        }
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
            class="setting-enum-select"
          >
            ${opts.options.map(
              (o) => html`
                <wa-option value=${String(o.value)}>${o.label}</wa-option>
              `,
            )}
          </wa-select>
        </div>
        ${
          isCustom
            ? this.renderResetButton(opts.field, String(opts.defaultValue))
            : nothing
        }
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

/**
 * LaTeX settings domain handlers.
 *
 * Extracted from SettingsViewMessageHandler to improve cohesion.
 * Handles LaTeX tool detection, recommended VS Code settings,
 * LaTeX Workshop installation, and install commands.
 */
import * as vscode from 'vscode';

import { SETTINGS_VIEW_COMMANDS } from '@common/webview';
import { showLoggedErrorMessage } from '@common/errors';
import { workspaceSM } from '@common/state';
import {
  LATEX_FIELD_TO_KEY,
  type LatexConfigField,
} from '@shared/constants/latex';
import {
  LatexConfigValuesSchema,
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
  type LatexConfigValues,
  type LatexSettingsStatus,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
  DEPENDENCY_INSTALL_COMMANDS,
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
} from '@shared/constants/latex';
import {
  getConfig,
  inspectConfig,
  isConfigExplicitlySet,
  updateConfig,
} from '@utils/config/configUtils';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import { BinaryResolver } from '@utils/system/binaryResolver';

import type { SettingsHandlerContext } from './SettingsHandlerContext';

/** How long cached LaTeX settings remain valid (ms). */
const LATEX_SETTINGS_CACHE_TTL = 60_000;

/** Recommended LaTeX-related VS Code settings and their target values. */
const LATEX_RECOMMENDED_SETTINGS: {
  key: string;
  value: unknown;
  field: 'outDir' | 'autoRevealExclude';
  /** Object keys from older TeXRA versions to migrate (remove on apply, clean on reset). */
  legacyKeys?: string[];
}[] = [
  {
    key: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    field: 'outDir',
  },
  {
    key: 'explorer.autoRevealExclude',
    value: { '**/build/': true },
    field: 'autoRevealExclude',
    // Old setup.ts wrote { 'build/': true } — migrate to **/build/
    legacyKeys: ['build/'],
  },
];

/** Allowlist of commands that may be executed via the Run in Terminal button. */
const ALLOWED_INSTALL_COMMANDS: ReadonlySet<string> = new Set([
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
  ...Object.values(DEPENDENCY_INSTALL_COMMANDS).flatMap((platforms) =>
    Object.values(platforms).flatMap((cmds) => cmds.map((cmd) => cmd.command)),
  ),
]);

/**
 * LaTeX settings handler delegate.
 * Manages LaTeX tool detection, recommended settings, and installation.
 */
export class LatexSettingsHandlers {
  /** Cached LaTeX settings to avoid redundant tool detection on repeat opens. */
  private latexSettingsCache: {
    settings: LatexSettingsStatus;
    timestamp: number;
  } | null = null;

  constructor(private readonly ctx: SettingsHandlerContext) {}

  async sendLatexSettingsStatus(webview: vscode.Webview): Promise<void> {
    const now = Date.now();
    if (
      !this.latexSettingsCache ||
      now - this.latexSettingsCache.timestamp >= LATEX_SETTINGS_CACHE_TTL
    ) {
      this.latexSettingsCache = {
        settings: await this.detectLatexSettings(),
        timestamp: now,
      };
    }

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings: this.latexSettingsCache.settings,
    });
  }

  async handleApplyLatexSettings(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.APPLY_LATEX_SETTINGS>,
  ): Promise<void> {
    try {
      const targets = data.field
        ? LATEX_RECOMMENDED_SETTINGS.filter((s) => s.field === data.field)
        : LATEX_RECOMMENDED_SETTINGS;

      for (const { key, value, legacyKeys } of targets) {
        let resolvedValue: unknown = data.reset ? undefined : value;

        if (typeof value === 'object' && value !== null) {
          const recommended = value as Record<string, unknown>;
          // Read only the user's explicit global entries — not VS Code defaults —
          // so we don't leak built-in defaults into settings.json.
          const inspection = inspectConfig<Record<string, unknown>>(key);
          const globalObj = inspection?.globalValue ?? {};
          const remaining = { ...globalObj };

          // Always clean up legacy keys from older TeXRA versions.
          for (const k of legacyKeys ?? []) {
            delete remaining[k];
          }

          if (data.reset) {
            // Remove the recommended keys, keep the user's other entries.
            for (const k of Object.keys(recommended)) {
              delete remaining[k];
            }
            resolvedValue =
              Object.keys(remaining).length > 0 ? remaining : undefined;
          } else {
            // Merge recommended keys into existing config.
            resolvedValue = { ...remaining, ...recommended };
          }
        }

        await updateConfig(key, resolvedValue, {
          target: 'global',
          prefix: false,
        });
      }

      await this.ctx.withActiveWebview((w) => this.sendLatexSettingsStatus(w));
      const verb = data.reset ? 'reset' : 'applied';
      void vscode.window.showInformationMessage(
        data.field
          ? `LaTeX setting ${verb}`
          : `All recommended LaTeX settings ${verb}`,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to update LaTeX settings',
        error,
      );
    }
  }

  async handleInstallLatexWorkshop(): Promise<void> {
    await this.installExtension(LATEX_WORKSHOP_EXT_ID, (w) =>
      this.sendLatexSettingsStatus(w),
    );
  }

  /**
   * Push current LaTeX/compile/diff config values to the webview. Each field
   * is left undefined when no value is set in workspace storage so the UI
   * can render the documented default rather than overwriting it on save.
   *
   * Iterates LATEX_FIELD_TO_KEY (the shared single-source-of-truth field/key
   * map) so the read path stays automatically aligned with the write path
   * and the migration helper.
   */
  async sendLatexConfigValues(webview: vscode.Webview): Promise<void> {
    const values: Partial<Record<LatexConfigField, unknown>> = {};
    for (const [field, key] of Object.entries(LATEX_FIELD_TO_KEY) as [
      LatexConfigField,
      Parameters<typeof workspaceSM.get>[0],
    ][]) {
      const stored = workspaceSM.get(key);
      if (stored !== undefined) values[field] = stored;
    }
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: values as LatexConfigValues,
    });
  }

  /**
   * Persist a single LaTeX/compile/diff config value to workspace storage.
   * `value === undefined` (or `null`) clears the key (returns to documented
   * default). Per-field validation is intentionally done here rather than in
   * the inbound message schema — the outer SettingsViewInboundMessageSchema
   * is a discriminatedUnion('command', …) and a nested per-field
   * discriminator on the same command literal would crash Zod with a
   * duplicate-discriminator error at parse time.
   */
  async handleSetLatexConfigValue(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.SET_LATEX_CONFIG_VALUE>,
  ): Promise<void> {
    const key = LATEX_FIELD_TO_KEY[data.field];
    // Validate value against the per-field schema in LatexConfigValuesSchema.
    // Both schemas mark the property optional, so undefined/null both parse to
    // undefined and clear the key.
    const fieldSchema = LatexConfigValuesSchema.shape[data.field];
    const parsed = fieldSchema.safeParse(data.value ?? undefined);
    if (!parsed.success) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        `Invalid value for ${data.field}`,
        parsed.error,
      );
      return;
    }
    try {
      await workspaceSM.update(key, parsed.data);
      await this.ctx.withActiveWebview((w) => this.sendLatexConfigValues(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        `Failed to update ${data.field}`,
        error,
      );
    }
  }

  async handleRunInstallCommand(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.RUN_INSTALL_COMMAND>,
  ): Promise<void> {
    if (!ALLOWED_INSTALL_COMMANDS.has(data.installCommand)) {
      this.ctx.logger.warn(
        this.ctx.channel,
        `Rejected unknown install command: ${data.installCommand}`,
      );
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: 'TeXRA Install',
      hideFromUser: false,
    });
    terminal.show();
    terminal.sendText(data.installCommand);
  }

  // ── Private helpers ──

  /**
   * Check whether a recommended LaTeX setting's value is active.
   * For string values: exact match.
   * For object values: recommended keys are a subset of the current config.
   */
  private isRecommendedValueSet(
    field: 'outDir' | 'autoRevealExclude',
  ): boolean {
    const setting = LATEX_RECOMMENDED_SETTINGS.find((s) => s.field === field);
    if (!setting) return false;
    if (!isConfigExplicitlySet(setting.key)) return false;

    const current = getConfig<unknown>(setting.key);
    if (typeof setting.value === 'object' && setting.value !== null) {
      // For object values, check that every recommended key is present
      if (typeof current !== 'object' || current === null) return false;
      const cur = current as Record<string, unknown>;
      const rec = setting.value as Record<string, unknown>;
      // Also treat legacy keys as "set" so existing users see the check mark
      // (they'll get migrated to the new key on next Apply).
      return (
        Object.entries(rec).every(([k, v]) => cur[k] === v) ||
        (setting.legacyKeys?.some((k) => cur[k] !== undefined) ?? false)
      );
    }
    return current === setting.value;
  }

  /** Run all tool checks and build the LaTeX settings status object.
   *  Returns defaults on failure so the webview spinner always dismisses. */
  private async detectLatexSettings(): Promise<LatexSettingsStatus> {
    try {
      const [
        pdflatexOk,
        latexmkOk,
        latexdiffOk,
        latexindentOk,
        perlOk,
        texcountOk,
        gsOk,
        gmOk,
        magickOk,
      ] = await Promise.all([
        checkToolInstalled('pdflatex', false),
        checkToolInstalled('latexmk', false),
        checkToolInstalled('latexdiff', false),
        checkToolInstalled('latexindent', false),
        checkToolInstalled('perl', false),
        checkToolInstalled('texcount', false),
        checkToolInstalled('gs', false),
        checkToolInstalled('gm', false),
        checkToolInstalled('magick', false),
      ]);

      const platform = normalizePlatform(process.platform);

      return {
        outDir: this.isRecommendedValueSet('outDir'),
        autoRevealExclude: this.isRecommendedValueSet('autoRevealExclude'),
        texDistributionInstalled: pdflatexOk || latexmkOk,
        latexWorkshopInstalled: Boolean(
          vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID),
        ),
        latexdiffInstalled: latexdiffOk,
        latexindentInstalled: latexindentOk && perlOk,
        texcountInstalled: texcountOk,
        imageProcessingInstalled: gsOk && (gmOk || magickOk),
        platform,
        pdflatexPath: BinaryResolver.resolvePath('pdflatex'),
        latexmkPath: BinaryResolver.resolvePath('latexmk'),
        latexdiffPath: BinaryResolver.resolvePath('latexdiff'),
        latexindentPath: BinaryResolver.resolvePath('latexindent'),
        texcountPath: BinaryResolver.resolvePath('texcount'),
        ghostscriptPath: BinaryResolver.resolvePath('gs'),
        graphicsmagickPath:
          BinaryResolver.resolvePath('gm') ??
          BinaryResolver.resolvePath('magick'),
        packageManager: detectPackageManager(),
      };
    } catch (err) {
      this.ctx.logger.error(
        this.ctx.channel,
        `LaTeX settings detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ...DEFAULT_LATEX_SETTINGS_STATUS,
        platform: normalizePlatform(process.platform),
      };
    }
  }

  /** Install a VS Code extension and optionally refresh the given view data. */
  async installExtension(
    extensionId: string,
    refresh?: (w: vscode.Webview) => Promise<void>,
  ): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        extensionId,
      );
      void vscode.window.showInformationMessage(
        `Extension "${extensionId}" installed`,
      );
      if (refresh) {
        await this.ctx.withActiveWebview(refresh);
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        `Failed to install extension "${extensionId}"`,
        error,
      );
    }
  }
}

/**
 * LaTeX settings domain handlers.
 *
 * Extracted from SettingsViewMessageHandler to improve cohesion.
 * Handles LaTeX tool detection, recommended VS Code settings,
 * LaTeX Workshop installation, and install commands.
 */
import * as vscode from 'vscode';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexRecommendedSettingsController } from '@controllers/settingsView/LatexRecommendedSettingsController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview';
import { toErrorMessage } from '@common/errors';
import { workspaceSM } from '@common/state';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
  type LatexSettingsStatus,
} from '@shared/schemas/settingsViewMessages';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
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

/**
 * LaTeX settings handler delegate.
 * Manages LaTeX tool detection, recommended settings, and installation.
 */
export class LatexSettingsHandlers {
  private readonly recommendedSettingsController =
    new LatexRecommendedSettingsController({
      config: {
        getConfig: (key) => getConfig<unknown>(key),
        getGlobalValue: (key) =>
          inspectConfig<Record<string, unknown>>(key)?.globalValue,
        isExplicitlySet: (key) => isConfigExplicitlySet(key),
      },
    });

  private readonly toolingController = new LatexToolingController({
    checkToolInstalled: (tool) => checkToolInstalled(tool, false),
    findPath: (tool) => BinaryResolver.findPath(tool),
    detectPackageManager,
    getPlatform: () => normalizePlatform(process.platform),
    isLatexWorkshopInstalled: () =>
      Boolean(vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID)),
    getRecommendedStatus: () => ({
      outDir:
        this.recommendedSettingsController.isRecommendedValueSet('outDir'),
      autoRevealExclude:
        this.recommendedSettingsController.isRecommendedValueSet(
          'autoRevealExclude',
        ),
    }),
    onDetectionError: (error) => {
      this.ctx.logger.error(
        this.ctx.channel,
        `LaTeX settings detection failed: ${toErrorMessage(error)}`,
      );
    },
  });

  private readonly configPersistenceController =
    new LatexConfigPersistenceController();

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
        settings: await this.toolingController.detectStatus(),
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
      for (const {
        key,
        value,
      } of this.recommendedSettingsController.buildUpdates({
        field: data.field,
        reset: data.reset ?? false,
      })) {
        await updateConfig(key, value, {
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
    const values = this.configPersistenceController.buildConfigValues((key) =>
      workspaceSM.get(key),
    );
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values,
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
    const plan = this.configPersistenceController.planUpdate({
      field: data.field,
      value: data.value,
    });
    if (!plan.ok) {
      await showLoggedErrorMessage(
        this.ctx.channel,
        `Invalid value for ${data.field}`,
        plan.error,
      );
      return;
    }
    try {
      await workspaceSM.update(plan.update.key, plan.update.value);
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
    if (!this.toolingController.isAllowedInstallCommand(data.installCommand)) {
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

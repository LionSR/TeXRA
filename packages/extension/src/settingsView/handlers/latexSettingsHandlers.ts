/**
 * LaTeX settings domain handlers.
 *
 * Handles LaTeX tool detection, recommended VS Code settings,
 * LaTeX Workshop installation, and install commands.
 */
import * as vscode from 'vscode';

import { workspaceSM } from '@common/state';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { LatexRecommendedSettingsController } from '@controllers/settingsView/LatexRecommendedSettingsController';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { platform } from '@platform/platform';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  SETTINGS_VIEW_CMD,
  type SettingsMessageFor,
} from '@shared/schemas/settingsViewMessages';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
} from '@shared/constants/latexToolchain';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import { BinaryResolver } from '@utils/system/binaryResolver';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** LaTeX settings handler delegate. */
export class LatexSettingsHandlers {
  private readonly recommendedSettingsController =
    new LatexRecommendedSettingsController({
      config: {
        getConfig: (key) => vscode.workspace.getConfiguration().get(key),
        getGlobalValue: (key) =>
          vscode.workspace
            .getConfiguration()
            .inspect<Record<string, unknown>>(key)?.globalValue,
        isExplicitlySet: (key) => {
          const inspection = vscode.workspace.getConfiguration().inspect(key);
          return (
            inspection?.globalValue !== undefined ||
            inspection?.workspaceValue !== undefined ||
            inspection?.workspaceFolderValue !== undefined
          );
        },
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

  constructor(private readonly ctx: SettingsHandlerContext) {}

  async sendLatexSettingsStatus(webview: vscode.Webview): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings: await this.toolingController.detectStatus(),
    });
  }

  async handleApplyLatexSettings(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.APPLY_LATEX_SETTINGS>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to update LaTeX settings',
      async () => {
        for (const {
          key,
          value,
        } of this.recommendedSettingsController.buildUpdates({
          field: data.field,
          reset: data.reset ?? false,
        })) {
          await vscode.workspace
            .getConfiguration()
            .update(key, value, vscode.ConfigurationTarget.Global);
        }

        await this.ctx.withActiveWebview((w) =>
          this.sendLatexSettingsStatus(w),
        );
        const verb = data.reset ? 'reset' : 'applied';
        void vscode.window.showInformationMessage(
          data.field
            ? `LaTeX setting ${verb}`
            : `All recommended LaTeX settings ${verb}`,
        );
      },
    );
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
   */
  async sendLatexConfigValues(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      this.configPersistenceController.buildConfigMessage(
        (key) => workspaceSM.get(key),
        platform().config,
      ),
    );
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
    await withHandlerErrorHandling(
      this.ctx,
      `Failed to install extension "${extensionId}"`,
      async () => {
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
      },
    );
  }
}

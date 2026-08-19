/**
 * LaTeX settings domain handlers.
 *
 * Handles LaTeX tool detection, recommended VS Code settings,
 * LaTeX Workshop installation, and install commands.
 */
import * as vscode from 'vscode';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { platform } from '@platform/platform';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';
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

type LatexRecommendedSettingField = 'outDir' | 'autoRevealExclude';

/** A recommended setting whose target value is a single scalar. */
interface LatexRecommendedScalarSetting {
  kind: 'scalar';
  key: string;
  value: string;
  field: LatexRecommendedSettingField;
}

/**
 * A recommended setting whose target value is an object merged key-by-key
 * into whatever the user already has set (rather than overwritten wholesale).
 */
interface LatexRecommendedObjectSetting {
  kind: 'object';
  key: string;
  value: Record<string, unknown>;
  field: LatexRecommendedSettingField;
}

type LatexRecommendedSetting =
  LatexRecommendedScalarSetting | LatexRecommendedObjectSetting;

/** Recommended LaTeX-related VS Code settings and their target values. */
const LATEX_RECOMMENDED_SETTINGS: LatexRecommendedSetting[] = [
  {
    kind: 'scalar',
    key: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    field: 'outDir',
  },
  {
    kind: 'object',
    key: 'explorer.autoRevealExclude',
    value: { '**/build/': true },
    field: 'autoRevealExclude',
  },
];

/**
 * Whether a recommended setting is explicitly set to its recommended value.
 * An object setting counts as set when it contains every recommended entry;
 * the user's other keys are irrelevant.
 */
function isRecommendedValueSet(field: LatexRecommendedSettingField): boolean {
  const setting = LATEX_RECOMMENDED_SETTINGS.find(
    (candidate) => candidate.field === field,
  );
  if (!setting) return false;
  const inspection = vscode.workspace.getConfiguration().inspect(setting.key);
  const explicitlySet =
    inspection?.globalValue !== undefined ||
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined;
  if (!explicitlySet) return false;

  const current = vscode.workspace.getConfiguration().get(setting.key);
  if (setting.kind === 'scalar') {
    return current === setting.value;
  }

  if (typeof current !== 'object' || current === null) return false;
  const currentObject = current as Record<string, unknown>;
  return Object.entries(setting.value).every(
    ([key, value]) => currentObject[key] === value,
  );
}

/**
 * The value to write for one recommended setting. Object settings merge into
 * (and, on reset, unmerge out of) the user's existing global value so their
 * unrelated keys survive both directions.
 */
function resolveUpdateValue(
  setting: LatexRecommendedSetting,
  reset: boolean,
): unknown {
  if (setting.kind === 'scalar') {
    return reset ? undefined : setting.value;
  }

  const globalValue = vscode.workspace
    .getConfiguration()
    .inspect<Record<string, unknown>>(setting.key)?.globalValue;
  const remaining =
    typeof globalValue === 'object' && globalValue !== null
      ? { ...globalValue }
      : {};

  if (reset) {
    for (const recommendedKey of Object.keys(setting.value)) {
      delete remaining[recommendedKey];
    }
    return Object.keys(remaining).length > 0 ? remaining : undefined;
  }

  return { ...remaining, ...setting.value };
}

/** LaTeX settings handler delegate. */
export class LatexSettingsHandlers {
  private readonly toolingController = new LatexToolingController({
    checkToolInstalled: (tool) => checkToolInstalled(tool, false),
    findPath: (tool) => BinaryResolver.findPath(tool),
    detectPackageManager,
    getPlatform: () => normalizePlatform(process.platform),
    isLatexWorkshopInstalled: () =>
      Boolean(vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID)),
    getRecommendedStatus: () => ({
      outDir: isRecommendedValueSet('outDir'),
      autoRevealExclude: isRecommendedValueSet('autoRevealExclude'),
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
        const reset = data.reset ?? false;
        const targets = data.field
          ? LATEX_RECOMMENDED_SETTINGS.filter(
              (setting) => setting.field === data.field,
            )
          : LATEX_RECOMMENDED_SETTINGS;
        for (const setting of targets) {
          await vscode.workspace
            .getConfiguration()
            .update(
              setting.key,
              resolveUpdateValue(setting, reset),
              vscode.ConfigurationTarget.Global,
            );
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
        (key) => platform().workspaceState.get(key),
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

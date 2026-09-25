/**
 * LaTeX settings domain handlers.
 *
 * Handles LaTeX tool detection, recommended VS Code settings,
 * LaTeX Workshop installation, and install commands.
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';

import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import { error as logError, warn as logWarning } from '@logger/logUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsMessageFor } from '@shared/settingsView/settingsViewMessages';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
} from '@shared/constants/latexToolchain';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import { findToolInCommonPaths } from '@utils/system/binaryResolver';

import {
  postToWebview,
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

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

/** The LaTeX tab's inbound arms, spread into the settings-view registry. */
type LatexTabHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP
  | typeof SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND
>;

/** LaTeX settings handler delegate. */
export class LatexSettingsHandlers {
  readonly handlers: LatexTabHandlers;

  private readonly toolingController = new LatexToolingController({
    checkToolInstalled: (tool) => checkToolInstalled(tool, false),
    findPath: findToolInCommonPaths,
    detectPackageManager,
    getPlatform: () => normalizePlatform(process.platform),
    isLatexWorkshopInstalled: () =>
      Boolean(vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID)),
    getRecommendedStatus: () => ({
      outDir: isRecommendedValueSet('outDir'),
      autoRevealExclude: isRecommendedValueSet('autoRevealExclude'),
    }),
    onDetectionError: (error) => {
      logError(
        this.ctx.channel,
        `LaTeX settings detection failed: ${toErrorMessage(error)}`,
      );
    },
  });

  constructor(private readonly ctx: SettingsHandlerContext) {
    // Each arm is a settings-view message, so its program settles on the
    // view's boundary here rather than in the view's own registry.
    this.handlers = {
      applyLatexSettings: (message) => this.handleApplyLatexSettings(message),
      installLatexWorkshop: () => this.handleInstallLatexWorkshop(),
      runInstallCommand: (message) => this.handleRunInstallCommand(message),
    };
  }

  sendLatexSettingsStatus(webview: vscode.Webview) {
    return Effect.flatMap(this.toolingController.detectStatus(), (settings) =>
      postToWebview(webview, {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
        settings,
      }),
    );
  }

  private handleApplyLatexSettings(
    data: SettingsMessageFor<
      typeof SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS
    >,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to update LaTeX settings',
      Effect.gen({ self: this }, function* () {
        const reset = data.reset ?? false;
        const targets = data.field
          ? LATEX_RECOMMENDED_SETTINGS.filter(
              (setting) => setting.field === data.field,
            )
          : LATEX_RECOMMENDED_SETTINGS;
        for (const setting of targets) {
          yield* Effect.tryPromise({
            try: () =>
              vscode.workspace
                .getConfiguration()
                .update(
                  setting.key,
                  resolveUpdateValue(setting, reset),
                  vscode.ConfigurationTarget.Global,
                ),
            catch: ensureError,
          });
        }

        yield* this.ctx.withActiveWebview((w) =>
          this.sendLatexSettingsStatus(w),
        );
        const verb = reset ? 'reset' : 'applied';
        void vscode.window.showInformationMessage(
          data.field
            ? `LaTeX setting ${verb}`
            : `All recommended LaTeX settings ${verb}`,
        );
      }),
    );
  }

  private handleInstallLatexWorkshop() {
    return this.installExtension(LATEX_WORKSHOP_EXT_ID, (w) =>
      this.sendLatexSettingsStatus(w),
    );
  }

  private handleRunInstallCommand(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND>,
  ) {
    return Effect.sync(() => {
      if (
        !this.toolingController.isAllowedInstallCommand(data.installCommand)
      ) {
        logWarning(
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
    });
  }

  /** Install a VS Code extension and optionally refresh the given view data. */
  installExtension(
    extensionId: string,
    refresh?: (
      w: vscode.Webview,
    ) => Effect.Effect<void, Error, ChildProcessSpawner>,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      `Failed to install extension "${extensionId}"`,
      Effect.gen({ self: this }, function* () {
        yield* Effect.tryPromise({
          try: () =>
            vscode.commands.executeCommand(
              'workbench.extensions.installExtension',
              extensionId,
            ),
          catch: ensureError,
        });
        void vscode.window.showInformationMessage(
          `Extension "${extensionId}" installed`,
        );
        if (refresh) {
          yield* this.ctx.withActiveWebview(refresh);
        }
      }),
    );
  }
}

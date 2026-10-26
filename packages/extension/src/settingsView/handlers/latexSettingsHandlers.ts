/**
 * The settings arms only VS Code answers: writing the recommended LaTeX
 * editor settings and installing extensions. The rest of the Tools and LaTeX
 * pages is the shared settings body's (`settingsToolCommands`).
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import { ensureError } from '@texra-ai/harness/schemas';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import { showLoggedInfoMessage } from '@frontend/ui/errorHandlingUtils';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { LatexEditorStatus } from '@texra/controllers/settingsView/LatexToolingController';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import type { createSettingsViewBody } from '@texra/controllers/settingsView/sharedSettingsCommands';
import {
  LATEX_RECOMMENDED_SETTINGS,
  LATEX_WORKSHOP_EXT_ID,
  type LatexRecommendedSetting,
  type LatexRecommendedSettingField,
} from '@texra/shared/constants/latexToolchain';

const CHANNEL = 'latexSettingsHandlers';

/**
 * Whether a recommended setting is explicitly set to its recommended value.
 * An object setting counts as set when it contains every recommended entry;
 * the user's other keys are irrelevant.
 */
function isRecommendedValueSet(field: LatexRecommendedSettingField): boolean {
  const setting = LATEX_RECOMMENDED_SETTINGS[field];
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

/** Which recommended settings are applied and whether LaTeX Workshop is
 *  installed, for the LaTeX page's status. */
export function latexEditorStatus(): LatexEditorStatus {
  return {
    outDir: isRecommendedValueSet('outDir'),
    autoRevealExclude: isRecommendedValueSet('autoRevealExclude'),
    latexWorkshopInstalled:
      vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID) !== undefined,
  };
}

/** The arms, spread into the settings-view registry. Each reports its own
 *  failure in its own words and repaints the LaTeX status it changed. */
export function vscodeLatexSettingsHandlers(
  body: Pick<
    ReturnType<typeof createSettingsViewBody>,
    'postLatexStatus' | 'reported'
  >,
): Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP
  | typeof SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION
> {
  const installExtension = <E, R>(
    extensionId: string,
    refresh: Effect.Effect<void, E, R>,
  ) =>
    body.reported(
      `Failed to install extension "${extensionId}"`,
      Effect.gen(function* () {
        yield* executeVscodeCommand(
          'workbench.extensions.installExtension',
          extensionId,
        );
        yield* Effect.forkDetach(
          showLoggedInfoMessage(
            CHANNEL,
            `Extension "${extensionId}" installed`,
          ),
        );
        yield* refresh;
      }),
    );

  return {
    applyLatexSettings: (data) =>
      body.reported(
        'Failed to update LaTeX settings',
        Effect.gen(function* () {
          const reset = data.reset ?? false;
          const targets = data.field
            ? [LATEX_RECOMMENDED_SETTINGS[data.field]]
            : Object.values(LATEX_RECOMMENDED_SETTINGS);
          // Each setting is a distinct key, so the updates run at once.
          yield* Effect.forEach(
            targets,
            (setting) =>
              Effect.tryPromise({
                try: () =>
                  vscode.workspace
                    .getConfiguration()
                    .update(
                      setting.key,
                      resolveUpdateValue(setting, reset),
                      vscode.ConfigurationTarget.Global,
                    ),
                catch: ensureError,
              }),
            { concurrency: 'unbounded', discard: true },
          );

          yield* body.postLatexStatus;
          const verb = reset ? 'reset' : 'applied';
          yield* Effect.forkDetach(
            showLoggedInfoMessage(
              CHANNEL,
              data.field
                ? `LaTeX setting ${verb}`
                : `All recommended LaTeX settings ${verb}`,
            ),
          );
        }),
      ),
    installLatexWorkshop: () =>
      installExtension(LATEX_WORKSHOP_EXT_ID, body.postLatexStatus),
    installToolExtension: (message) =>
      installExtension(message.extensionId, Effect.void),
  };
}

/**
 * The settings arms only VS Code answers: writing the recommended LaTeX
 * editor settings and installing extensions. The rest of the Tools and LaTeX
 * pages is the shared settings body's (`settingsToolCommands`).
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import type { LatexRecommendedStatus } from '@controllers/settingsView/LatexToolingController';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import type { createSettingsViewBody } from '@controllers/settingsView/sharedSettingsCommands';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { LATEX_WORKSHOP_EXT_ID } from '@shared/constants/latexToolchain';
import { ensureError } from '@utils/errors/errorMessage';

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

/** Which recommended settings are applied, for the LaTeX page's status. */
export function latexRecommendedStatus(): LatexRecommendedStatus {
  return {
    outDir: isRecommendedValueSet('outDir'),
    autoRevealExclude: isRecommendedValueSet('autoRevealExclude'),
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

          yield* body.postLatexStatus;
          const verb = reset ? 'reset' : 'applied';
          void vscode.window.showInformationMessage(
            data.field
              ? `LaTeX setting ${verb}`
              : `All recommended LaTeX settings ${verb}`,
          );
        }),
      ),
    installLatexWorkshop: () =>
      installExtension(LATEX_WORKSHOP_EXT_ID, body.postLatexStatus),
    installToolExtension: (message) =>
      installExtension(message.extensionId, Effect.void),
  };
}

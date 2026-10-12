/**
 * The settings arms only VS Code answers: writing the recommended LaTeX
 * editor settings and installing extensions. The rest of the Tools and LaTeX
 * pages is the shared settings body's (`settingsToolCommands`).
 */
import { Effect } from 'effect';
import * as vscode from 'vscode';

import { showLoggedInfoMessage } from '@frontend/ui/errorHandlingUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { LatexEditorStatus } from '@texra/controllers/settingsView/LatexToolingController';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import type { createSettingsViewBody } from '@texra/controllers/settingsView/sharedSettingsCommands';
import { LATEX_WORKSHOP_EXT_ID } from '@texra/shared/constants/latexToolchain';
import { ensureError } from '@utils/errors/errorMessage';

const CHANNEL = 'latexSettingsHandlers';

const OUT_DIR = '%DIR%/build/';
const AUTO_REVEAL_EXCLUDE = 'explorer.autoRevealExclude';
const AUTO_REVEAL_EXCLUDE_ENTRIES: Record<string, unknown> = {
  '**/build/': true,
};

/** A recommended LaTeX-related VS Code setting. */
interface LatexRecommendedSetting {
  key: string;
  /** Whether `current` already holds the recommended value. */
  holds(current: unknown): boolean;
  /** The global value to write; `undefined` removes the setting. */
  update(reset: boolean): unknown;
}

/** Recommended LaTeX-related VS Code settings, by status field. */
const LATEX_RECOMMENDED_SETTINGS: Record<
  'outDir' | 'autoRevealExclude',
  LatexRecommendedSetting
> = {
  outDir: {
    key: 'latex-workshop.latex.outDir',
    holds: (current) => current === OUT_DIR,
    update: (reset) => (reset ? undefined : OUT_DIR),
  },
  // An object merged key-by-key into (and, on reset, unmerged out of) the
  // user's existing global value, so their unrelated keys survive both
  // directions. It holds when it contains every recommended entry.
  autoRevealExclude: {
    key: AUTO_REVEAL_EXCLUDE,
    holds: (current) =>
      typeof current === 'object' &&
      current !== null &&
      Object.entries(AUTO_REVEAL_EXCLUDE_ENTRIES).every(
        ([key, value]) => Reflect.get(current, key) === value,
      ),
    update(reset) {
      const globalValue = vscode.workspace
        .getConfiguration()
        .inspect<Record<string, unknown>>(AUTO_REVEAL_EXCLUDE)?.globalValue;
      const remaining =
        typeof globalValue === 'object' && globalValue !== null
          ? { ...globalValue }
          : {};
      if (!reset) return { ...remaining, ...AUTO_REVEAL_EXCLUDE_ENTRIES };
      for (const key of Object.keys(AUTO_REVEAL_EXCLUDE_ENTRIES)) {
        delete remaining[key];
      }
      return Object.keys(remaining).length > 0 ? remaining : undefined;
    },
  },
};

/** Whether a recommended setting is explicitly set to its recommended value. */
function isRecommendedValueSet({
  key,
  holds,
}: LatexRecommendedSetting): boolean {
  const inspection = vscode.workspace.getConfiguration().inspect(key);
  const explicitlySet =
    inspection?.globalValue !== undefined ||
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined;
  return explicitlySet && holds(vscode.workspace.getConfiguration().get(key));
}

/** Which recommended settings are applied and whether LaTeX Workshop is
 *  installed, for the LaTeX page's status. */
export function latexEditorStatus(): LatexEditorStatus {
  return {
    outDir: isRecommendedValueSet(LATEX_RECOMMENDED_SETTINGS.outDir),
    autoRevealExclude: isRecommendedValueSet(
      LATEX_RECOMMENDED_SETTINGS.autoRevealExclude,
    ),
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
        yield* Effect.tryPromise({
          try: () =>
            vscode.commands.executeCommand(
              'workbench.extensions.installExtension',
              extensionId,
            ),
          catch: ensureError,
        });
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
          for (const setting of targets) {
            yield* Effect.tryPromise({
              try: () =>
                vscode.workspace
                  .getConfiguration()
                  .update(
                    setting.key,
                    setting.update(reset),
                    vscode.ConfigurationTarget.Global,
                  ),
              catch: ensureError,
            });
          }

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

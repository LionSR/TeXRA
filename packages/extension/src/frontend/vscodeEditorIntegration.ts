/**
 * VS Code as the host's code editor: its extension registry and Marketplace
 * install, and the LaTeX settings TeXRA recommends in it. The composition
 * root passes it to the process layer (the setup tools and the Lean probe)
 * and to the settings view.
 */
import { Effect, Predicate } from 'effect';
import * as vscode from 'vscode';

import { ensureError } from '@texra-ai/harness/schemas';
import { executeVscodeCommand } from '@frontend/system/commandUtils';
import type { EditorIntegrationShape } from '@texra/hosts/editorIntegration';
import {
  LATEX_RECOMMENDED_SETTINGS,
  type LatexRecommendedSetting,
  type LatexRecommendedSettingField,
} from '@texra/shared/constants/latexToolchain';

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

  if (!Predicate.isObjectOrArray(current)) return false;
  const currentEntries = new Map<string, unknown>(Object.entries(current));
  return Object.entries(setting.value).every(
    ([key, value]) => currentEntries.get(key) === value,
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
  const remaining = Predicate.isObjectOrArray(globalValue)
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

export const vscodeEditorIntegration: EditorIntegrationShape = {
  installed: (extensionId) =>
    vscode.extensions.getExtension(extensionId) !== undefined,
  install: (extensionId) =>
    executeVscodeCommand(
      'workbench.extensions.installExtension',
      extensionId,
    ).pipe(Effect.asVoid),
  recommendedSettings: () => ({
    outDir: isRecommendedValueSet('outDir'),
    autoRevealExclude: isRecommendedValueSet('autoRevealExclude'),
  }),
  applyRecommended: (field, reset) =>
    // Each setting is a distinct key, so the updates run at once.
    Effect.forEach(
      field
        ? [LATEX_RECOMMENDED_SETTINGS[field]]
        : Object.values(LATEX_RECOMMENDED_SETTINGS),
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
    ),
};

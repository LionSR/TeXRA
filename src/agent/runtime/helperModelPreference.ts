/**
 * Helper-model preference for the "fix LaTeX" VS Code actions.
 *
 * The Fix-Compilation command and the progress-view compile fixer launch
 * latexFixer through `texra.execute` with `preferHelperModel`, so {@link runAgent}
 * runs them on the configured helper model rather than the heavyweight model the
 * user has selected. Every other launch (a direct main-view Run, the CLI, an
 * orchestrator delegation) leaves the flag off and keeps the chosen model.
 */

import { Effect } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { withLogChannel } from '@logger/effectLog';
import {
  modelUnavailableReasonFrom,
  readModelAvailabilityInputs,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';

import { AgentCategory } from '@shared/schemas';
import { getHelperModelName } from './helperModelName';

const CHANNEL = 'helperModelPreference';

/**
 * Swap `config`'s model for the configured helper model, or return it unchanged
 * when the helper model already equals it, a tool-use agent's helper model can't
 * call functions, or the helper model is unavailable.
 *
 * `stores` are the secret store and the session's setting slots the launching
 * run already holds, so the preference and the availability answer are read
 * from the same stores as the run itself.
 */
export const applyHelperModelPreference = Effect.fn(
  'applyHelperModelPreference',
)(function* (config: AgentConfig, stores: ModelOptionStores) {
  const helperModel = getHelperModelName(stores.globalState);
  if (helperModel === config.model) return config;

  const helperModelConfig = getRuntimeModelConfig(helperModel);

  // A tool-use agent (e.g. latexFixer) needs its tools, so do not assign a
  // helper model that does not declare function calling — not only one that
  // explicitly sets the capability to false.
  if (
    config.agentCategory === AgentCategory.ToolUse &&
    !helperModelConfig?.capabilities.supportsFunctionCalling
  ) {
    yield* Effect.logWarning(
      `Keeping ${config.model} for ${config.agent}: helper model ${helperModel} does not support function calling.`,
    ).pipe(withLogChannel(CHANNEL));
    return config;
  }

  const unavailable = modelUnavailableReasonFrom(
    yield* readModelAvailabilityInputs(stores, [helperModel]),
    helperModel,
  );
  if (unavailable) {
    yield* Effect.logWarning(
      `Keeping ${config.model} for ${config.agent}: helper model ${helperModel} is unavailable. ${unavailable}`,
    ).pipe(withLogChannel(CHANNEL));
    return config;
  }

  return { ...config, model: helperModel };
});

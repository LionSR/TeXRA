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
import { createLog } from '@logger/logUtils';
import {
  modelUnavailableReasonFrom,
  readModelAvailabilityInputs,
  type ModelAvailabilityScope,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';

import { AgentCategory } from '@shared/schemas';
import { getHelperModelName } from './helperModelName';

const log = createLog('helperModelPreference');

/**
 * Swap `config`'s model for the configured helper model, or return it unchanged
 * when the helper model already equals it, a tool-use agent's helper model can't
 * call functions, or the helper model is unavailable.
 *
 * `stores` are the process secret store and global state the launching run
 * already holds (the `Secrets` / `AppState` services), so the preference and
 * the availability answer are read from the same stores as the run itself.
 * `inScope` is the launching run's session frame, handed to the reads rather
 * than wrapped around this call: the reads are Effects, so a wrapper would
 * enter the frame around building the program instead of around running it.
 */
export const applyHelperModelPreference = Effect.fn(
  'applyHelperModelPreference',
)(function* (
  config: AgentConfig,
  stores: ModelOptionStores,
  inScope: ModelAvailabilityScope = (read) => read(),
) {
  const helperModel = getHelperModelName(stores.globalState);
  if (helperModel === config.model) return config;

  const helperModelConfig = yield* resolveRuntimeModelConfig(helperModel);

  // A tool-use agent (e.g. latexFixer) needs its tools, so do not assign a
  // helper model that does not declare function calling — not only one that
  // explicitly sets the capability to false.
  if (
    config.agentCategory === AgentCategory.ToolUse &&
    !helperModelConfig?.capabilities.supportsFunctionCalling
  ) {
    log.warn(
      `Keeping ${config.model} for ${config.agent}: helper model ${helperModel} does not support function calling.`,
    );
    return config;
  }

  const unavailable = modelUnavailableReasonFrom(
    yield* readModelAvailabilityInputs(stores, [helperModel], inScope),
    helperModel,
  );
  if (unavailable) {
    log.warn(
      `Keeping ${config.model} for ${config.agent}: helper model ${helperModel} is unavailable. ${unavailable}`,
    );
    return config;
  }

  return { ...config, model: helperModel };
});

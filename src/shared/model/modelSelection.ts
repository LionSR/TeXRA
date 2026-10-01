/**
 * The model a run, a setting or a delegation names. TeXRA stores one string
 * per choice: llm-zoo's selection form `provider/id[@effort][+pro]` (e.g.
 * `anthropic/claude-opus-5@high`), which names the model by its provider's
 * own API ID and says how to run it.
 */
import {
  lookup,
  parseModelRef,
  type ModelConfig,
  type ModelSelection,
} from 'llm-zoo';

export interface SelectedModel {
  /** The string as stored; the run's `modelId`. */
  readonly id: string;
  readonly config: ModelConfig;
  /** The effort, thinking and mode the string asks for, if any. */
  readonly request: Omit<ModelSelection, 'ref'>;
}

/** The model and reasoning request a stored model string names, or `undefined` when it names no registered model. */
export function selectModel(id: string): SelectedModel | undefined {
  const selection = parseModelRef(id);
  const config = selection && lookup(selection.ref);
  if (!selection || !config) return undefined;
  const { ref: _ref, ...request } = selection;
  return { id, config, request };
}

/** The registry entry a stored model string names. */
export function modelConfig(id: string): ModelConfig | undefined {
  return selectModel(id)?.config;
}

/**
 * The model reference a stored model string names, without its effort or
 * mode: what availability, enablement and per-model settings are keyed by.
 */
export function modelRefOf(id: string): string | undefined {
  return selectModel(id)?.config.ref;
}

/**
 * A model string as it may appear in a file or folder name: the model's API
 * id without its provider or selection suffix (`gpt-6.1-sol`), or the string
 * with path and shell-unsafe characters replaced when it names no model.
 */
export function modelFileName(id: string): string {
  return (modelConfig(id)?.id ?? id).replaceAll(/[\\/:*?"<>|@+\s]/g, '-');
}

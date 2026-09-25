import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

/** Trailing llm-zoo date pin (`-2026-04-23`) on a model `fullName`. */
const CODEX_MODEL_DATE_PIN = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The model id the Codex backend keys on: the `fullName` with its llm-zoo date
 * pin stripped.
 *
 * Never the `shortName`. That is llm-zoo's display abbreviation, and for every
 * Codex-eligible model but one it happens to equal the backend slug — which is
 * why preferring it went unnoticed. The exception is the GPT-5.6 family, whose
 * members are `gpt-5.6-sol`, `-terra` and `-luna`: there is no bare `gpt-5.6`
 * model anywhere, but that is exactly the `shortName` llm-zoo gives Sol. We
 * sent it and the backend answered
 * `The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
 * account.` — a message that reads as a subscription problem and sends users
 * to check their plan, when the id was simply not a model.
 */
export function codexBackendModelId(
  config: Pick<ModelConfig, 'name' | 'fullName'>,
): string {
  // The canonical registry `fullName`, not the caller's. A bound config has
  // already been through `withShortModelName`, which overwrites `fullName`
  // with `shortName` when "Prefer short model names" is on — reinstating the
  // exact `gpt-5.6` this function exists to never send (#12873). `name` is
  // the persisted registry id and is not rewritten anywhere on this path, so
  // it is the one field that still identifies the model. A config the
  // registry does not know (a runtime-discovered entry) has no canonical name
  // to read, so its own `fullName` is the only answer available.
  const canonical = MODEL_CONFIGS[config.name]?.fullName;
  return (canonical ?? config.fullName).replace(CODEX_MODEL_DATE_PIN, '');
}

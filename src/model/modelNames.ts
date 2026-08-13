/**
 * Model-family predicates over model names. Centralizes the scattered
 * `startsWith` checks so short config names (e.g. `gpt5high`) and full API
 * ids (e.g. `gpt-5`) are classified consistently everywhere.
 */

/** True for GPT-5 family models — matches short names (`gpt5*`) and full ids (`gpt-5*`). */
export function isGpt5ModelName(name: string): boolean {
  return name.startsWith('gpt5') || name.startsWith('gpt-5');
}

/** True for any GPT-family model name (`gpt4*`, `gpt5*`, `gpt-oss*`, …). */
export function isGptFamilyModelName(name: string): boolean {
  return name.toLowerCase().startsWith('gpt');
}

/** Model-name normalization shared by relay modules. */

/** Lowercase and trim an API model name. */
export function normalizeModelName(modelName: string): string {
  return modelName.toLowerCase().trim();
}

/** Drop an optional "provider/" prefix ("openai/gpt-4o-mini" → "gpt-4o-mini"). */
export function stripProviderPrefix(name: string): string {
  return name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
}

export function isGpt5Model(modelName: string | null): boolean {
  if (!modelName) return false;
  const modelPart = stripProviderPrefix(normalizeModelName(modelName));
  return modelPart.startsWith('gpt-5') || modelPart.startsWith('gpt5');
}

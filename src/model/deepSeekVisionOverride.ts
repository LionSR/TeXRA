import type { ModelConfig } from 'llm-zoo';

/**
 * TeXRA-local patch: llm-zoo 1.29.0 (`texra-ai/llm-zoo`) has no registry
 * entry for DeepSeek's vision-capable model, so every DeepSeek entry ships
 * `capabilities.supportsVision: false`. DeepSeek's own Vision API guide
 * (api-docs.deepseek.com/guides/vision) documents image input on exactly one
 * model id, `deepseek-v4-flash-vision-exp` — other DeepSeek models reject an
 * image with a 400 ("This model does not support image"). There is no
 * documented vision variant of the Pro line, so only the Flash entries are
 * patched.
 *
 * Delete this override (and the two call sites in runtimeModelRegistry.ts)
 * once llm-zoo ships a registry entry for the vision model directly.
 */
const DEEPSEEK_VISION_FULL_NAME = 'deepseek-v4-flash-vision-exp';
const DEEPSEEK_VISION_OVERRIDE_MODELS: ReadonlySet<string> = new Set([
  'deepseek',
  'deepseekT',
]);

/** Apply the local DeepSeek vision patch to one registry entry, if it applies. */
export function withDeepSeekVisionOverride(config: ModelConfig): ModelConfig {
  if (!DEEPSEEK_VISION_OVERRIDE_MODELS.has(config.name)) return config;
  return {
    ...config,
    fullName: DEEPSEEK_VISION_FULL_NAME,
    shortName: DEEPSEEK_VISION_FULL_NAME,
    // Clear the stale non-vision OpenRouter slug instead of guessing whether
    // OpenRouter proxies the vision-exp id: this falls back to
    // `${provider}/${fullName}`, the same derivation ModelFactory.ts uses for
    // every entry that leaves openrouterFullName unset.
    openrouterFullName: undefined,
    capabilities: { ...config.capabilities, supportsVision: true },
  };
}

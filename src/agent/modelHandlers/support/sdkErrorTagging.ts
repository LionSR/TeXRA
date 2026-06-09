/**
 * Generic SDK error tagging wrapper used by the base model handler.
 *
 * Provider-specific SDK class checks live beside each provider handler; this
 * module must stay free of provider SDK imports so host startup can load base
 * handler code without pulling OpenAI/Anthropic/Google clients into the eager graph.
 */
export type SdkErrorTagger = (err: unknown, provider: string) => void;

/**
 * Wraps a promise so that any rejection is tagged via the supplied tagger
 * before being re-thrown. Centralizes the common SDK-boundary catch pattern
 * while preserving the original error object.
 */
export async function withSdkErrorTag<T>(
  tagger: SdkErrorTagger,
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    tagger(err, provider);
    throw err;
  }
}

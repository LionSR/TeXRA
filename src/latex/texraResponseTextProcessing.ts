import { Effect } from 'effect';
import type { ConfigProvider } from '@platform/interfaces';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
type ResponseTextPostProcessor = (text: string) => string;

/**
 * Latex-owned policy contract for provider-output cleanup; latex owns the
 * type and the TeXRA-specific factory.
 */
export interface ResponseTextProcessing {
  readonly normalizeResponseText: ResponseTextPostProcessor;
  /**
   * Cleanup for one run's response text, over the configuration of the
   * workspace that run belongs to: the replacement rules are that project's
   * settings, not whichever roots the calling fiber carries.
   */
  readonly postProcessResponse: (
    text: string,
    config: ConfigProvider,
  ) => Effect.Effect<string>;
}

/** Create TeXRA's LaTeX-aware provider-output policy, injected by hosts. */
export function createTexraResponseTextProcessing(): ResponseTextProcessing {
  return Object.freeze<ResponseTextProcessing>({
    normalizeResponseText: (text) => text.trim(),
    postProcessResponse: (text, config) =>
      Effect.suspend(() => {
        const replaced = replacementEngine.applyAll(text, (key) =>
          config.get(key),
        );
        return logReplacementDiagnostics(replaced.diagnostics).pipe(
          Effect.as(replaced.text),
        );
      }),
  });
}

import { Effect } from 'effect';
import type { ConfigProvider } from '@platform/interfaces';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import type { HttpClient } from 'effect/unstable/http';

type ResponseTextPostProcessor = (text: string) => string;

/** How two adjacent pieces of continued response text are joined. */
export type ResponseTextConnector = (
  previous: string,
  next: string,
) => Effect.Effect<string, never, HttpClient.HttpClient>;

/**
 * Latex-owned policy contract for provider-output cleanup and joining
 * continued responses. The agent runtime supplies only the connector
 * strategy; latex owns the type and the TeXRA-specific factory.
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
  readonly connectResponseText: ResponseTextConnector;
}

/** Create TeXRA's LaTeX-aware provider-output policy, injected by hosts. */
export function createTexraResponseTextProcessing(
  connectResponseText: ResponseTextConnector,
): ResponseTextProcessing {
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
    connectResponseText,
  });
}

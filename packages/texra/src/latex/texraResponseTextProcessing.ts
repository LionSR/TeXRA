import { Effect } from 'effect';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import type { ConfigProvider } from '@texra-ai/harness';

/**
 * TeXRA's LaTeX-aware provider-output policy, which hosts pass as a session's
 * `responseTextProcessing` (the harness's contract, which it satisfies
 * structurally: latex does not import the agent runtime).
 */
export function createTexraResponseTextProcessing(): {
  readonly postProcessResponse: (
    text: string,
    config: ConfigProvider,
  ) => Effect.Effect<string>;
} {
  return Object.freeze({
    postProcessResponse: (text: string, config: ConfigProvider) =>
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

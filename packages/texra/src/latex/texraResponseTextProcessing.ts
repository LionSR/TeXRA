import { Effect } from 'effect';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import type { ConfigProvider } from '@texra-ai/harness';

/**
 * TeXRA's LaTeX-aware cleanup of the text a provider returned, over the
 * replacement rules of the workspace the run belongs to (`config`), so the
 * rules are that project's settings.
 */
export const postProcessResponse = (
  text: string,
  config: ConfigProvider,
): Effect.Effect<string> =>
  Effect.suspend(() => {
    const replaced = replacementEngine.applyAll(text, (key) => config.get(key));
    return logReplacementDiagnostics(replaced.diagnostics).pipe(
      Effect.as(replaced.text),
    );
  });

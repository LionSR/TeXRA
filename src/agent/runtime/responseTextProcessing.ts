import { Effect } from 'effect';

import type { ConfigProvider } from '@platform/interfaces';

/**
 * A host's policy for the text a provider returns: cleanup for one run's
 * response text, over the configuration of the workspace that run belongs
 * to, so the rules are that project's settings, not whichever roots the
 * calling fiber carries. The harness owns the contract; TeXRA's hosts pass
 * the LaTeX-aware policy (`@latex/texraResponseTextProcessing`).
 */
export interface ResponseTextProcessing {
  readonly postProcessResponse: (
    text: string,
    config: ConfigProvider,
  ) => Effect.Effect<string>;
}

/**
 * The package default, deliberately neutral and deterministic: provider
 * text is returned unchanged.
 */
export function createNeutralResponseTextProcessing(): ResponseTextProcessing {
  return {
    postProcessResponse: (text) => Effect.succeed(text),
  };
}

import { Effect } from 'effect';

import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';

/**
 * Optional host policy for text returned by a provider.
 *
 * The package default is deliberately neutral and deterministic: provider
 * text is returned unchanged. TeXRA hosts may inject their LaTeX-specific
 * behavior via the latex-owned factory.
 */
export function createNeutralResponseTextProcessing(): ResponseTextProcessing {
  return {
    postProcessResponse: (text) => Effect.succeed(text),
  };
}

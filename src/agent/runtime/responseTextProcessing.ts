import { Effect } from 'effect';

import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';

/**
 * Optional host policy for text returned by a provider.
 *
 * The package default is deliberately neutral and deterministic: provider
 * text is returned unchanged. TeXRA hosts may inject their LaTeX-specific
 * behavior via the latex-owned factory.
 */

/** Preserve provider text when no host-specific post-processor is supplied. */
function preserveResponseText(text: string): string {
  return text;
}

/** Create neutral package defaults when a host supplies no text policy. */
export function createNeutralResponseTextProcessing(): ResponseTextProcessing {
  return {
    normalizeResponseText: preserveResponseText,
    postProcessResponse: (text) => Effect.succeed(text),
  };
}

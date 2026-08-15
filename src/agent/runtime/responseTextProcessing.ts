import type { ResponseTextProcessing } from '@latex/texraResponseTextProcessing';

/**
 * Optional host policy for text returned by a provider.
 *
 * The package defaults are deliberately neutral and deterministic: provider
 * text is returned unchanged, and adjacent non-whitespace text is separated
 * by one space. TeXRA hosts may inject their LaTeX-specific behavior via
 * the latex-owned factory.
 */

/** Preserve provider text when no host-specific post-processor is supplied. */
function preserveResponseText(text: string): string {
  return text;
}

async function connectResponseText(
  previous: string,
  next: string,
): Promise<string> {
  if (!previous || !next || /\s$/.test(previous) || /^\s/.test(next)) {
    return '';
  }
  return ' ';
}

/** Create neutral package defaults when a host supplies no text policy. */
export function createNeutralResponseTextProcessing(): ResponseTextProcessing {
  return {
    normalizeResponseText: preserveResponseText,
    postProcessResponse: preserveResponseText,
    connectResponseText,
  };
}

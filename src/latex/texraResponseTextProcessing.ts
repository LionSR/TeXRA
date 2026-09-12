import replacementEngine from '@replacement/engine';
import type { Effect } from 'effect';

type ResponseTextPostProcessor = (text: string) => string;

/** How two adjacent pieces of continued response text are joined. */
export type ResponseTextConnector = (
  previous: string,
  next: string,
) => Effect.Effect<string>;

/**
 * Latex-owned policy contract for provider-output cleanup and joining
 * continued responses. The agent runtime supplies only the connector
 * strategy; latex owns the type and the TeXRA-specific factory.
 */
export interface ResponseTextProcessing {
  readonly normalizeResponseText: ResponseTextPostProcessor;
  readonly postProcessResponse: ResponseTextPostProcessor;
  readonly connectResponseText: ResponseTextConnector;
}

/** Create TeXRA's LaTeX-aware provider-output policy, injected by hosts. */
export function createTexraResponseTextProcessing(
  connectResponseText: ResponseTextConnector,
): ResponseTextProcessing {
  return Object.freeze<ResponseTextProcessing>({
    normalizeResponseText: (text) => text.trim(),
    postProcessResponse: (text) => replacementEngine.applyAll(text),
    connectResponseText,
  });
}

import type { ResponseTextProcessing } from '@agent/runtime/responseTextProcessing';
import replacementEngine from '@replacement/engine';

/** TeXRA's LaTeX-aware provider-output policy, injected by application hosts. */
export const texraResponseTextProcessing: ResponseTextProcessing =
  Object.freeze<ResponseTextProcessing>({
    normalizeResponseText: (text) => text.trim(),
    postProcessResponse: (text) => replacementEngine.applyAll(text),
    connectResponseText: async (previous, next) => {
      const { bestConnectionMethod } =
        await import('@agent/runtime/textConnection');
      return (await bestConnectionMethod(previous, next)).connector;
    },
  });

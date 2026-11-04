import type { StreamingTextRow } from '@texra-ai/harness/transcript';

/**
 * What an assistant row says under an answer the model ended early
 * (`StreamingTextRow.cut`): which limit stopped it, so a reply that stops
 * mid-sentence is not read as the whole answer.
 */
export const RESPONSE_CUT_NOTE = Object.freeze({
  length: "The answer was cut short by the model's output limit.",
  'content-filter':
    "The answer was cut short by the provider's content filter.",
} satisfies Record<NonNullable<StreamingTextRow['cut']>, string>);

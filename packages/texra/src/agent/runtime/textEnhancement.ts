import { Effect } from 'effect';

import { withLogChannel } from '@texra-ai/harness';
import { helperCall } from '@agent/runtime/helperModel';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { extractTextFromTag } from '@texra/utils/text/xmlExtraction';
import { isNonEmptyString } from '@utils/text/stringUtils';

import type { WorkspaceRoots } from '@texra-ai/harness';

const CHANNEL = 'TextEnhancement';

/**
 * The polish instruction. The raw user text is appended after it verbatim;
 * nothing is templated, so user text can't inject template syntax.
 */
const POLISH_PROMPT_PREFIX =
  [
    'Correct any spelling errors, typos, grammatical mistakes, or punctuation ' +
      'issues. Preserve the original meaning and tone without adding new ' +
      'content or changing the structure unless necessary for clarity.',
    '',
    'Apply these formatting rules:',
    '1. If you spot inline LaTeX formulas, ensure they are wrapped with $ symbols (e.g., $E=mc^2$)',
    '2. If you spot XML tags, fix any unbalanced or unpaired tags',
    '3. If you spot Markdown syntax (like headers, lists, emphasis, links), fix any incorrect syntax',
    '',
    'Return the corrected text wrapped in <corrected_text> XML tags.',
    '',
    'Text to correct:',
  ].join('\n') + '\n';

/**
 * Polish `text` with the configured helper model. Fails with the reason the
 * helper could not answer, formatted for the user.
 *
 * The helper model is resolved and bound against the requesting roots'
 * setting slots and the process secret store, and the call is gated on the
 * process's retry gate.
 */
export const polishTextWithAI = Effect.fn('polishTextWithAI')(function* (
  text: string,
  roots: WorkspaceRoots,
  secrets: ModelOptionStores['secrets'],
) {
  return yield* Effect.gen(function* () {
    const responseText = yield* helperCall(
      { ...roots, secrets },
      { userPrompt: POLISH_PROMPT_PREFIX + text },
      // A draft polish serves no run and no agent category.
      { agentName: 'polish', runId: null },
    );
    if (!isNonEmptyString(responseText)) {
      return yield* Effect.fail(new Error('Model returned no text.'));
    }
    const corrected = extractTextFromTag(responseText, 'corrected_text');
    if (!corrected) {
      yield* Effect.logWarning(
        'Model did not wrap response in <corrected_text> tags; using raw response',
      ).pipe(withLogChannel(CHANNEL));
    }
    return (corrected ?? responseText).trim();
  }).pipe(
    Effect.catch((error) => {
      const message = getSdkErrorMessage(error);
      return Effect.logError(`Error polishing text: ${message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(Effect.fail(new Error(message, { cause: error }))),
      );
    }),
  );
});

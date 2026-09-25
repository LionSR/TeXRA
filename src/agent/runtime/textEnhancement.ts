import { Effect } from 'effect';

import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import { isNonEmptyString } from '@utils/text/stringUtils';

import { extractTextFromTag } from '@utils/text/xmlExtraction';
import { POLISH_PROMPT_PREFIX } from './bundledPrompts';
import { helperCompletion, helperModel } from './helperModel';
import type { HttpClient } from 'effect/unstable/http';

const CHANNEL = 'TextEnhancement';

/**
 * Polish `text` with the configured helper model. Fails with the reason the
 * helper could not answer, formatted for the user.
 *
 * `stores` are the secret store and the requesting session's setting slots the
 * calling host already holds, which the helper model is resolved and bound
 * against.
 */
export const polishTextWithAI = Effect.fn('polishTextWithAI')(function* (
  text: string,
  stores: ModelOptionStores,
): Effect.fn.Return<string, Error, LanguageModel | HttpClient.HttpClient> {
  return yield* Effect.gen(function* () {
    const bound = yield* helperModel(stores);
    const responseText = yield* helperCompletion(bound, {
      userPrompt: POLISH_PROMPT_PREFIX + text,
    });
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
    Effect.scoped,
    Effect.catch((error) => {
      const message = getSdkErrorMessage(error);
      return Effect.logError(`Error polishing text: ${message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(Effect.fail(new Error(message, { cause: error }))),
      );
    }),
  );
});

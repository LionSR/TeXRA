import { Effect } from 'effect';

import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { isNonEmptyString } from '@utils/text/stringUtils';

import { extractTextFromTag } from '@utils/text/xmlExtraction';
import { POLISH_PROMPT_PREFIX } from './bundledPrompts';
import { helperCompletion, helperModel } from './helperModel';
import type { HttpClient } from 'effect/unstable/http';

const log = createLog('TextEnhancement');

/**
 * Polish `text` with the configured helper model. Fails with the reason the
 * helper could not answer, formatted for the user.
 *
 * `stores` are the process secret store and global state the calling host
 * already holds (the `Secrets` / `AppState` services), which the helper model
 * is resolved against; `roots` are the setting slots beside them (the
 * requesting session's roots), which the bind reads its toggles from.
 */
export const polishTextWithAI = Effect.fn('polishTextWithAI')(function* (
  text: string,
  stores: ModelOptionStores,
  roots: SettingsStores,
): Effect.fn.Return<string, Error, LanguageModel | HttpClient.HttpClient> {
  return yield* Effect.gen(function* () {
    const bound = yield* helperModel(stores, roots);
    const responseText = yield* helperCompletion(bound, {
      userPrompt: POLISH_PROMPT_PREFIX + text,
    });
    if (!isNonEmptyString(responseText)) {
      return yield* Effect.fail(new Error('Model returned no text.'));
    }
    const corrected = extractTextFromTag(responseText, 'corrected_text');
    if (!corrected) {
      log.warn(
        'Model did not wrap response in <corrected_text> tags; using raw response',
      );
    }
    return (corrected ?? responseText).trim();
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => {
      const message = getSdkErrorMessage(error);
      log.error(`Error polishing text: ${message}`);
      return new Error(message, { cause: error });
    }),
  );
});

import { Effect } from 'effect';

import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import type { UsageLog } from '@shared/usageLog';
import { isNonEmptyString } from '@utils/text/stringUtils';

import { extractTextFromTag } from '@utils/text/xmlExtraction';
import { POLISH_PROMPT_PREFIX } from './bundledPrompts';
import { helperCall } from './helperModel';
import type { SessionHandle } from './SessionHandle';
import type { HttpClient } from 'effect/http';

const CHANNEL = 'TextEnhancement';

/**
 * Polish `text` with the configured helper model. Fails with the reason the
 * helper could not answer, formatted for the user.
 *
 * The helper model is resolved and bound against the requesting session's
 * setting slots and the process secret store, and the call is gated on the
 * session's retry gate.
 */
export const polishTextWithAI = Effect.fn('polishTextWithAI')(function* (
  text: string,
  session: SessionHandle,
  secrets: ModelOptionStores['secrets'],
): Effect.fn.Return<
  string,
  Error,
  LanguageModel | HttpClient.HttpClient | UsageLog
> {
  return yield* Effect.gen(function* () {
    const responseText = yield* helperCall(
      session,
      secrets,
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

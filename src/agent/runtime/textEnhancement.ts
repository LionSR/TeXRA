import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { isNonEmptyString } from '@utils/core';

import { extractTextFromTag } from '@utils/text/xmlExtraction';
import { POLISH_PROMPT_PREFIX } from './bundledPrompts';
import { createHelperModelKit, runHelperModelCompletion } from './helperModel';

const log = createLog('TextEnhancement');

/**
 * Polish `text` with the configured helper model.
 *
 * `stores` are the process secret store and global state the calling host
 * already holds (the `Secrets` / `AppState` services), which the helper model
 * is resolved against.
 */
export async function polishTextWithAI(
  text: string,
  stores: ModelOptionStores,
): Promise<{ success: boolean; text: string; error?: string }> {
  try {
    const helperResult = await createHelperModelKit(stores);
    if (!helperResult.kit) {
      throw new Error(helperResult.reason);
    }
    const responseText = await runHelperModelCompletion(helperResult.kit, {
      userPrompt: POLISH_PROMPT_PREFIX + text,
    });
    if (!isNonEmptyString(responseText)) {
      throw new Error('Model returned no text.');
    }

    const corrected = extractTextFromTag(responseText, 'corrected_text');
    if (!corrected) {
      log.warn(
        'Model did not wrap response in <corrected_text> tags; using raw response',
      );
    }
    return { success: true, text: (corrected ?? responseText).trim() };
  } catch (error) {
    const message = getSdkErrorMessage(error);
    log.error(`Error polishing text: ${message}`);
    return { success: false, text, error: message };
  }
}

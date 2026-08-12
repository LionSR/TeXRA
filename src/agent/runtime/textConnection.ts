import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { classifyAgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import * as logger from '@logger/logUtils';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';

interface ConnectionResult {
  connector: string;
  choice: string;
}

const CASE_CONNECTORS: Record<string, string> = {
  A: '',
  B: ' ',
  C: '\n',
};

const DEFAULT_RESULT: ConnectionResult = {
  connector: CASE_CONNECTORS.B,
  choice: 'B',
};

function buildPrompt(str1: string, str2: string): string {
  return (
    `Given three strings from a LaTeX document:\n` +
    `A: ${str1}${str2}\n` +
    `B: ${str1} ${str2}\n` +
    `C: ${str1}\n${str2}\n` +
    `Which string is grammatically correct in English and LaTeX? Output only 'A', 'B', or 'C'.`
  );
}

const SYSTEM_PROMPT =
  'Choose the grammatically correct string for its LaTeX document context.';

/**
 * Determines the best way to connect two strings in a LaTeX context, using
 * the configured helper model.
 */
export async function bestConnectionMethod(
  str1: string,
  str2: string,
): Promise<ConnectionResult> {
  try {
    const helperResult = await createHelperModelKit();
    if (!helperResult.kit) {
      logger.debug(
        CHANNEL,
        `Skipping bestConnectionMethod helper call: ${helperResult.reason}`,
      );
      return DEFAULT_RESULT;
    }

    const text = await runHelperModelCompletion(helperResult.kit, {
      userPrompt: buildPrompt(str1, str2),
      systemPrompt: SYSTEM_PROMPT,
    });
    const choice = text.trim();
    const connector = CASE_CONNECTORS[choice];
    if (connector === undefined) {
      logger.debug(CHANNEL, `Invalid choice: ${choice}. Defaulting to space.`);
      return DEFAULT_RESULT;
    }
    return { connector, choice };
  } catch (err) {
    const log =
      classifyAgentError(err) === 'missing-api-key'
        ? logger.debug
        : logger.error;
    log(CHANNEL, `Error in bestConnectionMethod: ${getSdkErrorMessage(err)}`);
    return DEFAULT_RESULT;
  }
}

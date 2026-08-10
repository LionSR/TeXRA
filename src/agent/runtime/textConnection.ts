import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { classifyAgentError, getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

const CHANNEL = 'LaTeXCommands';

interface ConnectionResult {
  connector: string;
  choice: string;
}

const CASE_CONNECTORS: Record<string, string> = {
  A: '',
  B: ' ',
  C: '\n',
};

const DEFAULT_RESULT: ConnectionResult = { connector: ' ', choice: 'B' };

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

function getMajorityChoice(choices: string[]): ConnectionResult {
  const counts = new Map<string, number>();
  for (const choice of choices) {
    counts.set(choice, (counts.get(choice) ?? 0) + 1);
  }

  const majorityChoice = [...counts.entries()].reduce((a, b) =>
    b[1] > a[1] ? b : a,
  )[0];

  const connector = CASE_CONNECTORS[majorityChoice];
  if (connector === undefined) {
    logger.debug(
      CHANNEL,
      `Invalid choice: ${majorityChoice}. Defaulting to space.`,
    );
    return DEFAULT_RESULT;
  }
  return { connector, choice: majorityChoice };
}

/**
 * Determines the best way to connect two strings in a LaTeX context, using
 * the configured helper model.
 */
export async function bestConnectionMethod(
  str1: string,
  str2: string,
  n: number = 1,
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

    const prompt = buildPrompt(str1, str2);
    const choices: string[] = [];
    for (let i = 0; i < Math.max(1, n); i += 1) {
      const text = await runHelperModelCompletion(helperResult.kit, {
        userPrompt: prompt,
        systemPrompt: SYSTEM_PROMPT,
      });
      choices.push(text.trim());
    }

    return getMajorityChoice(choices);
  } catch (err) {
    const log =
      classifyAgentError(err) === 'missing-api-key'
        ? logger.debug
        : logger.error;
    log(CHANNEL, `Error in bestConnectionMethod: ${getSdkErrorMessage(err)}`);
    return DEFAULT_RESULT;
  }
}

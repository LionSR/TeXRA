import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { classifyAgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import type { ResponseTextConnector } from '@latex/texraResponseTextProcessing';
import { createLog } from '@logger/logUtils';

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

const log = createLog(CHANNEL);

function buildPrompt(str1: string, str2: string): string {
  return `Given three strings from a LaTeX document:
A: ${str1}${str2}
B: ${str1} ${str2}
C: ${str1}
${str2}
Which string is grammatically correct in English and LaTeX? Output only 'A', 'B', or 'C'.`;
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
      log.debug(
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
      log.debug(`Invalid choice: ${choice}. Defaulting to space.`);
      return DEFAULT_RESULT;
    }
    return { connector, choice };
  } catch (err) {
    const write =
      classifyAgentError(err) === 'missing-api-key' ? log.debug : log.error;
    write(`Error in bestConnectionMethod: ${getSdkErrorMessage(err)}`);
    return DEFAULT_RESULT;
  }
}

/**
 * Agent-owned connector strategy for the latex response-text policy. Hosts
 * inject this through the latex-owned factory; it keeps the helper-model call
 * out of the latex layer.
 */
export const agentResponseTextConnector: ResponseTextConnector = async (
  previous,
  next,
) => (await bestConnectionMethod(previous, next)).connector;

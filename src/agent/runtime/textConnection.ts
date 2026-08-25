import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { classifyAgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import type { ResponseTextConnector } from '@latex/texraResponseTextProcessing';
import { createLog } from '@logger/logUtils';

const CASE_CONNECTORS: Record<string, string> = {
  A: '',
  B: ' ',
  C: '\n',
};

/** Case B: what a connector call falls back to when the helper cannot answer. */
const DEFAULT_CONNECTOR = CASE_CONNECTORS.B;

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
 * Agent-owned connector strategy for the latex response-text policy: asks the
 * configured helper model how two strings should be joined in a LaTeX
 * context. Hosts inject this through the latex-owned factory; it keeps the
 * helper-model call out of the latex layer.
 */
export const agentResponseTextConnector: ResponseTextConnector = async (
  previous,
  next,
) => {
  try {
    const helperResult = await createHelperModelKit();
    if (!helperResult.kit) {
      log.debug(`Skipping connector helper call: ${helperResult.reason}`);
      return DEFAULT_CONNECTOR;
    }

    const text = await runHelperModelCompletion(helperResult.kit, {
      userPrompt: buildPrompt(previous, next),
      systemPrompt: SYSTEM_PROMPT,
    });
    const choice = text.trim();
    const connector = CASE_CONNECTORS[choice];
    if (connector === undefined) {
      log.debug(`Invalid choice: ${choice}. Defaulting to space.`);
      return DEFAULT_CONNECTOR;
    }
    return connector;
  } catch (err) {
    const write =
      classifyAgentError(err) === 'missing-api-key' ? log.debug : log.error;
    write(`Error resolving text connector: ${getSdkErrorMessage(err)}`);
    return DEFAULT_CONNECTOR;
  }
};

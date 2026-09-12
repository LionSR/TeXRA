import { Effect } from 'effect';

import { helperCompletion, helperModel } from '@agent/runtime/helperModel';
import { classifyAgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import type { ResponseTextConnector } from '@latex/texraResponseTextProcessing';
import { createLog } from '@logger/logUtils';
import type { ModelOptionStores } from '@model/computeModelOptions';

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
 * context. Hosts inject the result through the latex-owned factory; it keeps
 * the helper-model call out of the latex layer.
 *
 * A {@link ResponseTextConnector} takes only the two strings, so the process
 * stores the helper model is resolved against are bound here, at the host root
 * that owns them, rather than looked up per call.
 */
export function createAgentResponseTextConnector(
  stores: ModelOptionStores,
): ResponseTextConnector {
  return (previous, next) =>
    Effect.gen(function* () {
      const bound = yield* helperModel(stores);
      const text = yield* helperCompletion(bound, {
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
    }).pipe(
      Effect.scoped,
      Effect.catchTag('HelperModelUnavailable', ({ reason }) => {
        log.debug(`Skipping connector helper call: ${reason}`);
        return Effect.succeed(DEFAULT_CONNECTOR);
      }),
      Effect.catch((err) => {
        const write =
          classifyAgentError(err) === 'missing-api-key' ? log.debug : log.error;
        write(`Error resolving text connector: ${getSdkErrorMessage(err)}`);
        return Effect.succeed(DEFAULT_CONNECTOR);
      }),
    );
}

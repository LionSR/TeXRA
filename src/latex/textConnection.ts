// Third-party imports
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Local imports - error utils
import { MODEL_CONFIGS } from 'llm-zoo';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export interface ConnectionResult {
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
    `Which is more english and latex grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason.`
  );
}

function getMajorityChoice(choices: string[]): ConnectionResult {
  const counts = new Map<string, number>();
  for (const choice of choices) {
    counts.set(choice, (counts.get(choice) ?? 0) + 1);
  }

  const majorityChoice = [...counts.entries()].reduce((a, b) =>
    b[1] > a[1] ? b : a,
  )[0];

  const connector = CASE_CONNECTORS[majorityChoice];
  if (connector !== undefined) {
    return { connector, choice: majorityChoice };
  }

  logger.debug(
    CHANNEL,
    `Invalid choice: ${majorityChoice}. Defaulting to space.`,
  );
  return DEFAULT_RESULT;
}

/**
 * Determines the best way to connect two strings in a LaTeX context using GPT-4
 */
export async function bestConnectionMethod(
  str1: string,
  str2: string,
  openaiApiKey?: string,
  n: number = 10,
): Promise<ConnectionResult> {
  try {
    const prompt = buildPrompt(str1, str2);
    const handler = new ModelHandlerOpenAI(MODEL_CONFIGS['gpt41']);
    const baseURL = handler.getBaseUrl() || undefined;
    const client = openaiApiKey
      ? new OpenAI({ apiKey: openaiApiKey, baseURL })
      : await handler.getClient();

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1',
      temperature: 0,
      n,
      messages: [
        {
          role: 'system',
          content:
            'You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const choices = completion.choices.map(
      (choice) => choice.message.content?.trim() ?? '',
    );
    return getMajorityChoice(choices);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in bestConnectionMethod: ${getSdkErrorMessage(err)}`,
    );
    return DEFAULT_RESULT;
  }
}

/**
 * Determines the best way to connect two strings in a LaTeX context using Claude
 */
export async function bestConnectionMethodAnthropic(
  str1: string,
  str2: string,
  anthropicApiKey?: string,
  n: number = 10,
): Promise<ConnectionResult> {
  try {
    const prompt = buildPrompt(str1, str2);
    const handler = new ModelHandlerAnthropic(MODEL_CONFIGS['sonnet37']);
    const baseURL = handler.getBaseUrl() || undefined;
    const client = anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey, baseURL })
      : await handler.getClient();

    const choices = await Promise.all(
      Array.from({ length: n }, () =>
        client.messages
          .create({
            model: 'claude-3-7-sonnet-20250219',
            max_tokens: 128,
            messages: [{ role: 'user', content: prompt }],
          })
          .then((response) => {
            const content = response.content[0];
            return 'text' in content ? content.text.trim() : 'B';
          }),
      ),
    );

    return getMajorityChoice(choices);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in bestConnectionMethodAnthropic: ${getSdkErrorMessage(err)}`,
    );
    return DEFAULT_RESULT;
  }
}

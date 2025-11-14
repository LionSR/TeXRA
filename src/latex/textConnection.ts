// Third-party imports
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Local imports - error utils
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import * as logger from '@logger/logUtils';
import { MODEL_CONFIGS } from '@model/ModelRegistry';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export interface ConnectionResult {
  connector: string;
  choice: string;
}

interface TestStrings {
  A: string;
  B: string;
  C: string;
}

const caseDict: { [key: string]: string } = {
  A: '',
  B: ' ',
  C: '\n',
};

/**
 * Prepares test strings and prompt for both implementations
 */
function preparePrompt(
  str1: string,
  str2: string,
): { strings: TestStrings; prompt: string } {
  const strings = {
    A: str1 + str2,
    B: str1 + ' ' + str2,
    C: str1 + '\n' + str2,
  };

  const prompt =
    `Given three strings from a LaTeX document:\n` +
    `A: ${strings.A}\n` +
    `B: ${strings.B}\n` +
    `C: ${strings.C}\n` +
    `Which is more english and latex grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason.`;

  return { strings, prompt };
}

/**
 * Processes choices to determine the majority vote
 */
function processMajorityChoice(choices: string[]): ConnectionResult {
  const choiceCounts = new Map<string, number>();
  choices.forEach((choice) => {
    choiceCounts.set(choice, (choiceCounts.get(choice) ?? 0) + 1);
  });

  let majorityChoice = '';
  let maxCount = 0;
  choiceCounts.forEach((count, choice) => {
    if (count > maxCount) {
      maxCount = count;
      majorityChoice = choice;
    }
  });

  if (majorityChoice in caseDict) {
    return {
      connector: caseDict[majorityChoice],
      choice: majorityChoice,
    };
  } else {
    logger.debug(
      CHANNEL,
      `Invalid choice: ${majorityChoice}. Defaulting to adding a space.`,
    );
    return {
      connector: ' ',
      choice: 'B',
    };
  }
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
    const { prompt } = preparePrompt(str1, str2);
    const handler = new ModelHandlerOpenAI(MODEL_CONFIGS['gpt41']);
    const baseURL = handler.getBaseUrl() || undefined;
    const client = openaiApiKey
      ? new OpenAI({ apiKey: openaiApiKey, baseURL })
      : await handler.getClient();

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1', //'gpt-4-turbo',
      temperature: 0,
      n,
      messages: [
        {
          role: 'system',
          content:
            'You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const choices = completion.choices.map(
      (choice) => choice.message.content?.trim() ?? '',
    );

    return processMajorityChoice(choices);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in bestConnectionMethod: ${getSdkErrorMessage(err)}`,
    );
    return {
      connector: ' ',
      choice: 'B',
    };
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
    const { prompt } = preparePrompt(str1, str2);
    const handler = new ModelHandlerAnthropic(MODEL_CONFIGS['sonnet37']);
    const baseURL = handler.getBaseUrl() || undefined;
    const client = anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey, baseURL })
      : await handler.getClient();

    // Make multiple API calls since Anthropic doesn't support n parameter
    const choices = await Promise.all(
      Array(n)
        .fill(null)
        .map(() =>
          client.messages
            .create({
              model: 'claude-3-7-sonnet-20250219',
              max_tokens: 128,
              messages: [
                {
                  role: 'user',
                  content: prompt,
                },
              ],
            })
            .then((response) => {
              const content = response.content[0];
              if ('text' in content) {
                return content.text.trim();
              }
              return 'B';
            }),
        ),
    );

    return processMajorityChoice(choices);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in bestConnectionMethodAnthropic: ${getSdkErrorMessage(err)}`,
    );
    return {
      connector: ' ',
      choice: 'B',
    };
  }
}

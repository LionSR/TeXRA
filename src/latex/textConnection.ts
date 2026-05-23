// Third-party imports
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { MODEL_CONFIGS } from 'llm-zoo';

import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { createHelperModelKit } from '@agent/runtime/helperModel';
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

function isMissingApiKeyMessage(message: string): boolean {
  return (
    message.includes('Missing API key') || message.includes('No API key found')
  );
}

function buildPrompt(str1: string, str2: string): string {
  return (
    `Given three strings from a LaTeX document:\n` +
    `A: ${str1}${str2}\n` +
    `B: ${str1} ${str2}\n` +
    `C: ${str1}\n${str2}\n` +
    `Which is more english and latex grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason.`
  );
}

const SYSTEM_PROMPT =
  'You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.';

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

async function bestConnectionMethodWithHelperModel(
  str1: string,
  str2: string,
  n: number,
): Promise<ConnectionResult> {
  const helperResult = await createHelperModelKit();
  if (!helperResult.kit) {
    logger.debug(
      CHANNEL,
      `Skipping bestConnectionMethod helper call: ${helperResult.reason}`,
    );
    return DEFAULT_RESULT;
  }

  const { handler, client } = helperResult.kit;
  const prompt = buildPrompt(str1, str2);
  const choices: string[] = [];

  for (let i = 0; i < Math.max(1, n); i += 1) {
    const messages = await handler.initializeMessages(
      '',
      prompt,
      undefined,
      SYSTEM_PROMPT,
    );
    const result = await handler.createResponse({
      client,
      messages,
      temperature: 0,
      systemPrompt: SYSTEM_PROMPT,
    });
    const { text } = handler.extractResponse(result.response, '');
    choices.push(text.trim());
  }

  return getMajorityChoice(choices);
}

/**
 * Determines the best way to connect two strings in a LaTeX context.
 */
export async function bestConnectionMethod(
  str1: string,
  str2: string,
  openaiApiKey?: string,
  n: number = 1,
): Promise<ConnectionResult> {
  try {
    if (!openaiApiKey) {
      return await bestConnectionMethodWithHelperModel(str1, str2, n);
    }

    const prompt = buildPrompt(str1, str2);
    const handler = new ModelHandlerOpenAI(MODEL_CONFIGS['gpt41']);
    const baseURL = handler.getBaseUrl() ?? undefined;
    const client = new OpenAI({ apiKey: openaiApiKey, baseURL });

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1',
      temperature: 0,
      n,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        { role: 'user', content: prompt },
      ],
    });

    const choices = completion.choices.map(
      (choice) => choice.message.content?.trim() ?? '',
    );
    return getMajorityChoice(choices);
  } catch (err) {
    const message = getSdkErrorMessage(err);
    const log = isMissingApiKeyMessage(message) ? logger.debug : logger.error;
    log(CHANNEL, `Error in bestConnectionMethod: ${message}`);
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
  n: number = 1,
): Promise<ConnectionResult> {
  try {
    if (!anthropicApiKey) {
      return await bestConnectionMethodWithHelperModel(str1, str2, n);
    }

    const prompt = buildPrompt(str1, str2);
    const handler = new ModelHandlerAnthropic(MODEL_CONFIGS['sonnet37']);
    const baseURL = handler.getBaseUrl() ?? undefined;
    const client = new Anthropic({ apiKey: anthropicApiKey, baseURL });

    const choices = await Promise.all(
      Array.from({ length: n }, () =>
        client.messages
          .create({
            model: 'claude-3-7-sonnet-20250219',
            max_tokens: 128,
            messages: [{ role: 'user', content: prompt }],
          })
          .then((response) => {
            const textBlock = response.content.find(
              (block) => block.type === 'text',
            );
            return textBlock?.text.trim() || 'B';
          }),
      ),
    );

    return getMajorityChoice(choices);
  } catch (err) {
    const message = getSdkErrorMessage(err);
    const log = isMissingApiKeyMessage(message) ? logger.debug : logger.error;
    log(CHANNEL, `Error in bestConnectionMethodAnthropic: ${message}`);
    return DEFAULT_RESULT;
  }
}

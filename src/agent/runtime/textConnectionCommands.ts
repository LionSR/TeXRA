import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { MODEL_CONFIGS } from 'llm-zoo';

import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import {
  createHelperModelKit,
  runHelperModelCompletion,
} from '@agent/runtime/helperModel';
import { classifyAgentError, getSdkErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export interface RuntimeTextConnectionResult {
  readonly connector: string;
  readonly choice: string;
}

export interface RuntimeTextConnectionRequest {
  readonly str1: string;
  readonly str2: string;
  readonly openaiApiKey?: string;
  readonly attempts?: number;
}

export interface RuntimeTextConnectionDiagnosticCase {
  readonly str1: string;
  readonly str2: string;
}

export interface RuntimeTextConnectionDiagnosticEntry {
  readonly provider: string;
  readonly str1: string;
  readonly str2: string;
  readonly result: RuntimeTextConnectionResult;
  readonly connectedText: string;
}

const CASE_CONNECTORS: Record<string, string> = {
  A: '',
  B: ' ',
  C: '\n',
};

const DEFAULT_RESULT: RuntimeTextConnectionResult = {
  connector: ' ',
  choice: 'B',
};

const SYSTEM_PROMPT =
  'You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.';

const DEFAULT_TEXT_CONNECTION_DIAGNOSTIC_CASES: readonly RuntimeTextConnectionDiagnosticCase[] =
  [
    { str1: 'Hello', str2: 'world' },
    { str1: 'The cat', str2: 'sat on the mat' },
    { str1: 'Therefore,', str2: 'we conclude' },
    { str1: '\\section{Introduction}', str2: 'This paper presents' },
  ];

function buildPrompt(str1: string, str2: string): string {
  return (
    `Given three strings from a LaTeX document:\n` +
    `A: ${str1}${str2}\n` +
    `B: ${str1} ${str2}\n` +
    `C: ${str1}\n${str2}\n` +
    `Which is more english and latex grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason.`
  );
}

function getMajorityChoice(
  choices: readonly string[],
): RuntimeTextConnectionResult {
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

function logConnectionError(operation: string, error: unknown): void {
  const message = getSdkErrorMessage(error);
  const log =
    classifyAgentError(error) === 'missing-api-key'
      ? logger.debug
      : logger.error;
  log(CHANNEL, `Error in ${operation}: ${message}`);
}

async function chooseConnectionWithHelperModel(
  str1: string,
  str2: string,
  attempts: number,
): Promise<RuntimeTextConnectionResult> {
  const helperResult = await createHelperModelKit();
  if (!helperResult.kit) {
    logger.debug(
      CHANNEL,
      `Skipping text connection helper call: ${helperResult.reason}`,
    );
    return DEFAULT_RESULT;
  }

  const prompt = buildPrompt(str1, str2);
  const choices: string[] = [];

  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    const text = await runHelperModelCompletion(helperResult.kit, {
      userPrompt: prompt,
      systemPrompt: SYSTEM_PROMPT,
    });
    choices.push(text.trim());
  }

  return getMajorityChoice(choices);
}

/**
 * Choose the host-neutral text connector between two adjacent LaTeX fragments.
 */
export async function chooseRuntimeTextConnection({
  str1,
  str2,
  openaiApiKey,
  attempts = 1,
}: RuntimeTextConnectionRequest): Promise<RuntimeTextConnectionResult> {
  try {
    if (!openaiApiKey) {
      return await chooseConnectionWithHelperModel(str1, str2, attempts);
    }

    const prompt = buildPrompt(str1, str2);
    const handler = new ModelHandlerOpenAI(MODEL_CONFIGS['gpt41']);
    const baseURL = handler.getBaseUrl() ?? undefined;
    const client = new OpenAI({ apiKey: openaiApiKey, baseURL });

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1',
      temperature: 0,
      n: attempts,
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
  } catch (error: unknown) {
    logConnectionError('chooseRuntimeTextConnection', error);
    return DEFAULT_RESULT;
  }
}

async function chooseRuntimeAnthropicTextConnection(
  str1: string,
  str2: string,
  anthropicApiKey?: string,
  attempts = 1,
): Promise<RuntimeTextConnectionResult> {
  try {
    if (!anthropicApiKey) {
      return await chooseConnectionWithHelperModel(str1, str2, attempts);
    }

    const prompt = buildPrompt(str1, str2);
    const handler = new ModelHandlerAnthropic(MODEL_CONFIGS['sonnet37']);
    const baseURL = handler.getBaseUrl() ?? undefined;
    const client = new Anthropic({ apiKey: anthropicApiKey, baseURL });

    const choices = await Promise.all(
      Array.from({ length: attempts }, () =>
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
  } catch (error: unknown) {
    logConnectionError('chooseRuntimeAnthropicTextConnection', error);
    return DEFAULT_RESULT;
  }
}

async function runProviderDiagnostics(
  provider: string,
  testCases: readonly RuntimeTextConnectionDiagnosticCase[],
  method: (str1: string, str2: string) => Promise<RuntimeTextConnectionResult>,
): Promise<RuntimeTextConnectionDiagnosticEntry[]> {
  const entries: RuntimeTextConnectionDiagnosticEntry[] = [];

  for (const { str1, str2 } of testCases) {
    const result = await method(str1, str2);
    entries.push({
      provider,
      str1,
      str2,
      result,
      connectedText: `${str1}${result.connector}${str2}`,
    });
  }

  return entries;
}

/** Run the host-triggered text-connection diagnostic suite. */
export async function runRuntimeTextConnectionDiagnostics(
  testCases: readonly RuntimeTextConnectionDiagnosticCase[] = DEFAULT_TEXT_CONNECTION_DIAGNOSTIC_CASES,
): Promise<RuntimeTextConnectionDiagnosticEntry[]> {
  return [
    ...(await runProviderDiagnostics('OpenAI', testCases, (str1, str2) =>
      chooseRuntimeTextConnection({ str1, str2 }),
    )),
    ...(await runProviderDiagnostics(
      'Anthropic',
      testCases,
      chooseRuntimeAnthropicTextConnection,
    )),
  ];
}

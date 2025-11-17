// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { showLoggedErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
} from '@latex/textConnection';

// Local imports - log

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export async function handleTestConnection(): Promise<void> {
  try {
    // Test cases
    const testCases = [
      { str1: 'Hello', str2: 'world' },
      { str1: 'The cat', str2: 'sat on the mat' },
      { str1: 'Therefore,', str2: 'we conclude' },
      { str1: '\\section{Introduction}', str2: 'This paper presents' },
    ];

    logger.info(CHANNEL, 'Testing OpenAI implementation:');
    for (const { str1, str2 } of testCases) {
      logger.debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethod(str1, str2);
      logger.info(CHANNEL, `Result: ${JSON.stringify(result)}`);
      logger.info(
        CHANNEL,
        `Connected text: "${str1}${result.connector}${str2}"`,
      );
    }

    logger.info(CHANNEL, '\n-------------------\n');

    logger.info(CHANNEL, 'Testing Anthropic implementation:');
    for (const { str1, str2 } of testCases) {
      logger.debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethodAnthropic(str1, str2);
      logger.info(CHANNEL, `Result: ${JSON.stringify(result)}`);
      logger.info(
        CHANNEL,
        `Connected text: "${str1}${result.connector}${str2}"`,
      );
    }

    vscode.window.showInformationMessage(
      'Check Debug Console for test results',
    );
  } catch (err) {
    logger.debug(
      CHANNEL,
      `Stack trace: ${err instanceof Error ? err.stack : ''}`,
    );
    await showLoggedErrorMessage(CHANNEL, 'Test failed', err);
  }
}

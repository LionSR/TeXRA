// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
} from '../../latex/textConnection';

// Local imports - log
import * as logger from '../../logger/logUtils';

const CHANNEL = 'ConnectionTests';
logger.initializeLogging(CHANNEL);

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
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(CHANNEL, `Test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      logger.debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`Test failed: ${errorMessage}`);
  }
}

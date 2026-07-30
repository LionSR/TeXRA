// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { bestConnectionMethod } from '@agent/runtime/textConnection';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';

const CHANNEL = 'TestCommands';

export async function handleTestConnection(): Promise<void> {
  const testCases = [
    { str1: 'Hello', str2: 'world' },
    { str1: 'The cat', str2: 'sat on the mat' },
    { str1: 'Therefore,', str2: 'we conclude' },
    { str1: '\\section{Introduction}', str2: 'This paper presents' },
  ];

  try {
    logger.info(CHANNEL, 'Testing helper model implementation:');
    for (const { str1, str2 } of testCases) {
      logger.debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethod(str1, str2);
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

import * as vscode from 'vscode';
import {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
} from '../textConnection';
import { info, debug, error, initializeLogging } from '../utils/logUtils';

const CHANNEL = 'TestCommands';
initializeLogging(CHANNEL);

export function registerTestCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.testConnection',
      handleTestConnection,
    ),
  );
  debug(CHANNEL, 'Test commands registered');
}

async function handleTestConnection(): Promise<void> {
  try {
    // Test cases
    const testCases = [
      { str1: 'Hello', str2: 'world' },
      { str1: 'The cat', str2: 'sat on the mat' },
      { str1: 'Therefore,', str2: 'we conclude' },
      { str1: '\\section{Introduction}', str2: 'This paper presents' },
    ];

    info(CHANNEL, 'Testing OpenAI implementation:');
    for (const { str1, str2 } of testCases) {
      debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethod(str1, str2);
      info(CHANNEL, `Result: ${JSON.stringify(result)}`);
      info(CHANNEL, `Connected text: "${str1}${result.connector}${str2}"`);
    }

    info(CHANNEL, '\n-------------------\n');

    info(CHANNEL, 'Testing Anthropic implementation:');
    for (const { str1, str2 } of testCases) {
      debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethodAnthropic(str1, str2);
      info(CHANNEL, `Result: ${JSON.stringify(result)}`);
      info(CHANNEL, `Connected text: "${str1}${result.connector}${str2}"`);
    }

    vscode.window.showInformationMessage(
      'Check Debug Console for test results',
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(CHANNEL, `Test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`Test failed: ${errorMessage}`);
  }
}

export const testCommands = {
  handleTestConnection,
};

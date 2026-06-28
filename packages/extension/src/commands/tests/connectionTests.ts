// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { runRuntimeTextConnectionDiagnostics } from '@agent/runtime/textConnectionCommands';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export async function handleTestConnection(): Promise<void> {
  try {
    const entries = await runRuntimeTextConnectionDiagnostics();
    let lastProvider: string | undefined;
    for (const entry of entries) {
      if (entry.provider !== lastProvider) {
        if (lastProvider) logger.info(CHANNEL, '\n-------------------\n');
        lastProvider = entry.provider;
        logger.info(CHANNEL, `Testing ${entry.provider} implementation:`);
      }
      logger.debug(CHANNEL, `\nTesting: "${entry.str1}" + "${entry.str2}"`);
      logger.info(CHANNEL, `Result: ${JSON.stringify(entry.result)}`);
      logger.info(CHANNEL, `Connected text: "${entry.connectedText}"`);
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

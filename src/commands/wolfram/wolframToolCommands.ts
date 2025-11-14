// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

// Internal imports
import * as logger from '@logger/logUtils';

// Internal imports
import { WolframTool } from '@tools/wolfram';

const CHANNEL = 'WolframToolCommands';
logger.initialize(CHANNEL);

export const wolframToolCommands = {
  testWolframTool: 'texra.testWolframTool',
};

export function registerWolframToolCommands(context: vscode.ExtensionContext) {
  const testCommand = vscode.commands.registerCommand(
    wolframToolCommands.testWolframTool,
    async () => {
      try {
        const code = await vscode.window.showInputBox({
          prompt: 'Enter Wolfram Language code to run with the tool',
          placeHolder: 'N[Pi,20]',
        });
        if (!code) {
          return;
        }
        const tool = new WolframTool();
        const result = await tool.call({ code });
        if (result.isError) {
          await showLoggedErrorMessage(
            CHANNEL,
            'Wolfram tool error',
            result.error,
          );
        } else {
          vscode.window.showInformationMessage(result.output ?? 'No output');
        }
      } catch (err) {
        await showLoggedErrorMessage(
          CHANNEL,
          'Error running Wolfram tool',
          err,
        );
      }
    },
  );
  context.subscriptions.push(testCommand);
  return { testCommand };
}

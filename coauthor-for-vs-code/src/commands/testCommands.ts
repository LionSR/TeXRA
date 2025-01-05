import * as vscode from 'vscode';
import * as logger from '../logger/logUtils';
import { handleTestConnection } from './tests/connectionTests';
import {
  handleTestAgentLoading,
  handleTestLoadSpecificAgent,
} from './tests/agentLoadingTests';

const CHANNEL = 'TestCommands';
logger.initializeLogging(CHANNEL);

export function registerTestCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.testConnection',
      handleTestConnection,
    ),
    vscode.commands.registerCommand('coauthor.testAgentLoading', () =>
      handleTestAgentLoading(context),
    ),
    vscode.commands.registerCommand('coauthor.testLoadSpecificAgent', () =>
      handleTestLoadSpecificAgent(context),
    ),
  );
  logger.debug(CHANNEL, 'Test commands registered');
}

export const testCommands = {
  handleTestConnection,
  handleTestAgentLoading,
  handleTestLoadSpecificAgent,
};

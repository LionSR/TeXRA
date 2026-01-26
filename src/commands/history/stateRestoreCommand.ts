// Third-party imports
import * as vscode from 'vscode';

// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas/mainViewState';

// Local imports - common
import { showLoggedErrorMessage } from '@common/errors';
import { setPendingState } from '@common/state';
import { COMMON_COMMANDS } from '@common/webview/commands';

// Local imports - frontend
import { getMainWebview } from '@frontend/system/commandUtils';

// Local imports - logging
import * as logger from '@logger/logUtils';

// Local imports - task state
import {
  isToolUseTaskState,
  isWorkflowTaskState,
  type TaskState,
} from '@logger/TaskState';

const CHANNEL = 'stateRestoreCommand';
logger.initialize(CHANNEL);

/**
 * Register state restore command with VS Code
 */
export function registerStateRestoreCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.restoreState', restoreState),
  );

  logger.info(CHANNEL, 'Registered state restore command');
}

/**
 * Restore the main webview state with configuration from a log tab.
 * @param state - The TaskState to restore
 * @param executeImmediately - If true, execute the agent after restoring state (for followup)
 */
async function restoreState(state: TaskState, executeImmediately?: boolean) {
  logger.debug(CHANNEL, 'Restoring main webview state', {
    data: { executeImmediately },
  });

  try {
    const nextState = buildMainViewState(state);

    // Focus the webview panel first to make sure it's visible
    await vscode.commands.executeCommand('texra.mainView.focus');

    const webviewView = await getMainWebview(CHANNEL);
    if (webviewView) {
      webviewView.webview.postMessage({
        command: COMMON_COMMANDS.STATE_RESTORE,
        state: nextState,
        executeImmediately,
      });
      logger.info(CHANNEL, 'State restored via direct webview access');
      return;
    }

    // Store the state in memory for the MainViewProvider to pick up
    setPendingState(nextState, executeImmediately);
    await vscode.commands.executeCommand('texra.mainView.focus');
    logger.info(CHANNEL, 'State stored for later restoration', {
      data: { executeImmediately },
    });
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}

function buildMainViewState(taskState: TaskState): MainViewPersistedState {
  const defaults = MainViewPersistedStateSchema.parse({});
  const { agentConfig } = taskState;
  const isToolUse = isToolUseTaskState(taskState);
  const isWorkflow = isWorkflowTaskState(taskState);
  const activeFiles = isWorkflow ? taskState.activeFiles : undefined;
  const toolConfig = agentConfig.toolConfig ?? {};

  const nextState: MainViewPersistedState = {
    ...defaults,
    sessionType: isToolUse ? 'toolUse' : 'workflow',
    workflowAgent: isToolUse ? defaults.workflowAgent : agentConfig.agent,
    toolUseAgent: isToolUse ? agentConfig.agent : defaults.toolUseAgent,
    model: agentConfig.model ?? defaults.model,
    instruction: agentConfig.instruction ?? defaults.instruction,
    inputFile: agentConfig.inputFile ?? defaults.inputFile,
    referenceFile: agentConfig.referenceFile ?? defaults.referenceFile,
    auxiliaryFile: agentConfig.auxiliaryFile ?? defaults.auxiliaryFile,
    mediaFile: agentConfig.mediaFile ?? defaults.mediaFile,
    editedFile: agentConfig.editedFile ?? defaults.editedFile,
    inputFiles: agentConfig.inputFiles ?? defaults.inputFiles,
    referenceFiles: agentConfig.referenceFiles ?? defaults.referenceFiles,
    auxiliaryFiles: agentConfig.auxiliaryFiles ?? defaults.auxiliaryFiles,
    mediaFiles: agentConfig.mediaFiles ?? defaults.mediaFiles,
    outputFiles: agentConfig.outputFiles ?? defaults.outputFiles,
    inputFilesVisible: activeFiles?.input ?? defaults.inputFilesVisible,
    referenceFilesVisible:
      activeFiles?.reference ?? defaults.referenceFilesVisible,
    auxiliaryFilesVisible:
      activeFiles?.auxiliary ?? defaults.auxiliaryFilesVisible,
    mediaFilesVisible: activeFiles?.media ?? defaults.mediaFilesVisible,
    outputFilesVisible: activeFiles?.output ?? defaults.outputFilesVisible,
    outputFilesActive: activeFiles?.output ?? defaults.outputFilesActive,
    autoExtractFigure:
      toolConfig.autoExtractFigure ?? defaults.autoExtractFigure,
    autoExtractTikzFigure:
      toolConfig.autoExtractTikzFigure ?? defaults.autoExtractTikzFigure,
    autoCompileInputPdf:
      toolConfig.autoCompileInputPdf ?? defaults.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount ?? defaults.attachTeXCount,
    attachDiagnostics:
      toolConfig.attachDiagnostics ?? defaults.attachDiagnostics,
    agent: agentConfig.agent ?? defaults.agent,
    isToolUseAgent: isToolUse,
  };

  return MainViewPersistedStateSchema.parse(nextState);
}

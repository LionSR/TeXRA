// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import { AgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';

// Local imports - history
import { AgentHistoryManager } from '@historyView/AgentHistoryManager';

// Local imports - utilities  
import { TaskStorageManager } from '@utils/taskStorage';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', (config: AgentConfig) =>
      executeCommand.executeCommand(config, context),
    ),
  );
}

export const executeCommand = {
  executeCommand: async (
    config: AgentConfig,
    context: vscode.ExtensionContext,
  ) => {
    try {
      // Create task storage for this execution
      const taskInfo = await TaskStorageManager.createTask(
        config.agent,
        config.model,
        config.inputFile,
        config.outputFiles || undefined
      );

      // Save the agent configuration to history with task ID
      await AgentHistoryManager.addToHistory(config, taskInfo.taskId);

      // Add task ID to config for downstream use
      (config as any).taskId = taskInfo.taskId;

      // Run the agent directly
      await executeAgent(config, context);

      // Update task status to completed
      await TaskStorageManager.updateTaskStatus(taskInfo.taskId, 'completed');
    } catch (err) {
      // Update task status to error if taskId is available
      const taskId = (config as any).taskId;
      if (taskId) {
        await TaskStorageManager.updateTaskStatus(taskId, 'error');
      }
      throw err;
    }
  },
};

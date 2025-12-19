/**
 * Command to continue a workflow agent's output with an interactive tool-use (chat) agent.
 *
 * This enables graceful chaining: when a workflow agent gets you 90% of the way there,
 * you can hand off to a chat agent for fine-tuning and interactive refinement.
 */

// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import { AgentHistoryManager } from '@common/history';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'ContinueWithChatCommand';

/**
 * Payload for the continueWithChat command.
 */
export interface ContinueWithChatPayload {
  /** The workflow context to pass to the chat agent (document content) */
  workflowContext: string;

  /** Optional instruction for what to do with the workflow output */
  instruction?: string;

  /** Optional model to use (defaults to config's default) */
  model?: string;

  /** Optional: input file path for the chat agent to work with */
  inputFile?: string;

  /** Optional: additional input files */
  inputFiles?: string[];

  /** Optional: reference files for context */
  referenceFiles?: string[];
}

/**
 * Builds the workflow context from a file path.
 * Reads the file content and returns it as a string.
 */
export async function buildWorkflowContextFromFile(
  filePath: string,
): Promise<string> {
  try {
    const content = await WorkspaceFS.read(filePath);
    return content;
  } catch (error) {
    logger.warn(CHANNEL, `Failed to read workflow output file: ${filePath}`, {
      data: error,
    });
    return '';
  }
}

/**
 * Builds the workflow context from multiple file paths.
 * Combines file contents with XML-style wrappers.
 */
export async function buildWorkflowContextFromFiles(
  filePaths: string[],
): Promise<string> {
  const contents = await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        const content = await WorkspaceFS.read(filePath);
        const fileName = filePath.split('/').pop() || filePath;
        return `<document name="${fileName}">\n${content}\n</document>`;
      } catch {
        return null;
      }
    }),
  );

  return contents.filter(Boolean).join('\n\n');
}

/**
 * Continues with a chat agent using the provided workflow context.
 */
export async function continueWithChat(
  payload: ContinueWithChatPayload,
): Promise<void> {
  const {
    workflowContext,
    instruction = 'Please review the workflow output above and help me refine it.',
    model,
    inputFile,
    inputFiles = [],
    referenceFiles = [],
  } = payload;

  if (!workflowContext || workflowContext.trim().length === 0) {
    void vscode.window.showWarningMessage(
      'No workflow context provided. Please run a workflow agent first.',
    );
    return;
  }

  // Build the agent configuration for the chat agent
  const chatConfig: Partial<AgentConfig> = {
    agent: 'chat',
    instruction,
    workflowContext,
    inputFile: inputFile || '',
    inputFiles,
    referenceFiles,
  };

  if (model) {
    chatConfig.model = model;
  }

  try {
    const normalizedConfig = parseAgentConfig(chatConfig);
    const executionId = randomUUID() as ExecutionId;

    await AgentHistoryManager.addToHistory(executionId, normalizedConfig);
    await executeAgent(normalizedConfig, executionId);

    logger.info(
      CHANNEL,
      `Started chat agent with workflow context (${workflowContext.length} chars)`,
    );
  } catch (error) {
    logger.error(CHANNEL, 'Failed to start chat agent', { data: error });
    void vscode.window.showErrorMessage(
      `Failed to continue with chat: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Registers the continueWithChat command.
 */
export function registerContinueWithChatCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.continueWithChat',
      async (payload: ContinueWithChatPayload) => {
        await continueWithChat(payload);
      },
    ),
  );

  // Also register a convenience command that prompts for input
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.continueWithChatFromFile',
      async (fileUri?: vscode.Uri) => {
        let filePath: string | undefined;

        if (fileUri) {
          filePath = fileUri.fsPath;
        } else {
          // Prompt user to select a file
          const selectedFiles = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select Workflow Output',
            filters: {
              'Text files': ['tex', 'txt', 'md', 'xml'],
              'All files': ['*'],
            },
          });

          if (!selectedFiles || selectedFiles.length === 0) {
            return;
          }
          filePath = selectedFiles[0].fsPath;
        }

        const workflowContext = await buildWorkflowContextFromFile(filePath);
        if (!workflowContext) {
          void vscode.window.showWarningMessage('Could not read the file.');
          return;
        }

        // Prompt for instruction
        const instruction = await vscode.window.showInputBox({
          prompt: 'What would you like to refine or change?',
          placeHolder:
            'e.g., "Polish the introduction" or "Fix the mathematical notation"',
          value: 'Please help me refine this document.',
        });

        if (instruction === undefined) {
          return; // User cancelled
        }

        await continueWithChat({
          workflowContext,
          instruction: instruction || 'Please help me refine this document.',
          inputFile: filePath,
        });
      },
    ),
  );
}

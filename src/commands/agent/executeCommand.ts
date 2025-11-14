// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - agent runtime
import { parseAgentConfig } from '@agent/core/AgentConfig';
import {
  executeAgent,
  resumeAgentExecution,
} from '@agent/runtime/executeAgent';
// Type imports
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - history
import { AgentHistoryManager } from '@historyView/managers';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ExecuteCommand';

// Add the registration function
export function registerExecuteCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.execute', (config: unknown) =>
      executeCommand.executeCommand(config),
    ),
  );
}

export const executeCommand = {
  async executeCommand(config: unknown) {
    try {
      const { payload, executionId, resume } = normalizePayload(config);
      const normalizedConfig = parseAgentConfig(payload);

      if (resume) {
        if (!executionId) {
          logger.warn(
            CHANNEL,
            'Resume requested without an execution ID; starting a new run instead.',
          );
        } else {
          await resumeAgentExecution(normalizedConfig, executionId);
          return;
        }
      }

      const resolvedExecutionId: ExecutionId =
        executionId ??
        (await AgentHistoryManager.addToHistory(normalizedConfig));

      await executeAgent(normalizedConfig, resolvedExecutionId);
    } catch (error) {
      if (error instanceof ZodError) {
        const detail = error.issues.map((issue) => issue.message).join('; ');
        const message =
          'Invalid agent configuration provided for execution.' +
          (detail ? ` ${detail}` : '');
        logger.warn(CHANNEL, message, undefined, undefined, false, error);
        void vscode.window.showErrorMessage(message);
        return;
      }

      logger.error(
        CHANNEL,
        'Agent execution failed before start.',
        undefined,
        undefined,
        false,
        error,
      );
      throw error;
    }
  },
};

function normalizePayload(input: unknown): {
  payload: unknown;
  executionId?: ExecutionId;
  resume: boolean;
  stream?: StreamTabId;
} {
  if (input && typeof input === 'object' && 'config' in (input as any)) {
    const candidate = input as {
      config: unknown;
      executionId?: unknown;
      resume?: unknown;
      stream?: unknown;
    };

    const executionId =
      typeof candidate.executionId === 'string'
        ? (candidate.executionId as ExecutionId)
        : undefined;

    return {
      payload: candidate.config,
      executionId,
      resume: Boolean(candidate.resume),
      stream:
        typeof candidate.stream === 'string'
          ? (candidate.stream as StreamTabId)
          : undefined,
    };
  }

  return { payload: input, resume: false };
}

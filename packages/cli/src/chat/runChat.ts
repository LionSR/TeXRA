// Local imports - agent
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { loadAgents } from '@agent/index';
import { interruptActiveChildren } from '@agent/runtime/executionRegistry';
import { executeAgent } from '@agent/runtime/executeAgent';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@shared/schemas';

// Local imports - CLI runtime
import {
  applyCliGlobalArgs,
  createCliLineReader,
  flagValue,
  type CliContext,
} from '../runtime/cliContext';
import {
  hasCliApprovalDenied,
  installCliApprovalHandlers,
} from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';

export interface ChatResult {
  exitCode: number;
}

const DEFAULT_CHAT_AGENT = 'chat';

function printChatHelp(): void {
  writeTextStderr(`Commands:
  /help          Show this help
  /agent <name> Set the tool-use agent before the session starts
  /model <name> Set the model before the session starts
  /yolo          Explain yolo approval mode
  /clear         Clear the terminal
  /exit, /quit   Exit chat`);
}

function printClearScreen(): void {
  writeTextStderr('\u001B[2J\u001B[H');
}

function parseCommand(line: string): { command: string; rest: string } {
  const [command = '', ...rest] = line.slice(1).trim().split(/\s+/);
  return { command: command.toLowerCase(), rest: rest.join(' ') };
}

export async function runChat(context: CliContext): Promise<ChatResult> {
  const args = context.argv.slice(1);
  const chatContext = applyCliGlobalArgs(context, args);
  if (chatContext.mode === 'headless') {
    writeTextStderr(
      'texra chat requires an interactive terminal. Did you mean texra run?',
    );
    return { exitCode: CliExitCode.Usage };
  }
  if (chatContext.approvalPolicy === 'ask') {
    writeTextStderr(
      'texra chat plain mode cannot prompt for approvals yet because chat input owns stdin. Use --approval-policy yolo for trusted local runs, --approval-policy never to fail closed, or texra run for workflow execution.',
    );
    return { exitCode: CliExitCode.Usage };
  }

  await initCliPlatform(chatContext);
  installCliApprovalHandlers(chatContext);
  await loadAgents();

  const runtimeHost = createCliRuntimeHost(chatContext);
  const reader = createCliLineReader('texra> ');
  let readerClosed = false;
  const closeReader = (): void => {
    if (readerClosed) return;
    readerClosed = true;
    reader.close();
  };
  let agent = flagValue(args, '--agent') ?? DEFAULT_CHAT_AGENT;
  let model = flagValue(args, '--model', '-m') ?? DEFAULT_AGENT_MODEL;
  let streamId: StreamTabId | undefined;
  let runCompleted = false;
  let runExitCode: CliExitCode = CliExitCode.Success;
  let runPromise: Promise<void> | undefined;
  let stopRequested = false;
  const pendingFollowUps: string[] = [];
  let followUpFlush = Promise.resolve();
  let streamReadyForFollowUps = false;

  const interruptActiveSession = (): void => {
    if (!streamId) return;
    interruptActiveChildren(streamId);
    getInterruptible(streamId)?.interrupt();
  };

  const requestChatExit = (): void => {
    stopRequested = true;
    if (runPromise && !runCompleted) {
      interruptActiveSession();
      writeTextStderr(
        'Exit requested; waiting for the active session to stop.',
      );
    }
    closeReader();
  };

  const flushPendingFollowUps = (): void => {
    if (!streamId || stopRequested || pendingFollowUps.length === 0) return;

    const lines = pendingFollowUps.splice(0);
    const waitForStreamActivation = !streamReadyForFollowUps;
    followUpFlush = followUpFlush
      .then(async () => {
        if (waitForStreamActivation) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          streamReadyForFollowUps = true;
        }
        for (const line of lines) {
          if (!streamId || stopRequested || runCompleted) return;
          const result = await sendFollowUp(streamId, line);
          if (result.status === 'no_session') {
            writeTextStderr('The chat session is no longer active.');
            closeReader();
            return;
          }
          if (result.status === 'queued') {
            writeTextStderr(
              `Follow-up queued while session is ${result.reason}.`,
            );
          }
        }
      })
      .catch((error) => {
        writeTextStderr(error instanceof Error ? error.message : String(error));
        closeReader();
      });
  };

  const queueFollowUp = (line: string): void => {
    pendingFollowUps.push(line);
    flushPendingFollowUps();
  };

  const startSession = (instruction: string): void => {
    const config: AgentConfigPayload = {
      agent,
      model,
      instruction,
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: chatContext.cwd,
    };

    runPromise = executeAgent(config, undefined, {
      runtimeHost,
      enforceCategory: true,
      onStreamResolved: (resolvedStreamId) => {
        streamId = resolvedStreamId;
        streamReadyForFollowUps = false;
        if (stopRequested) {
          interruptActiveSession();
        } else {
          flushPendingFollowUps();
        }
      },
    })
      .then((result) => {
        runExitCode =
          result.status === 'error' && hasCliApprovalDenied(chatContext)
            ? CliExitCode.ApprovalDenied
            : result.status === 'error'
              ? CliExitCode.AgentError
              : CliExitCode.Success;
        if (result.category === 'toolUse' && result.lastResponse) {
          writeTextStdout(result.lastResponse);
        }
      })
      .catch((error) => {
        runExitCode = CliExitCode.AgentError;
        writeTextStderr(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        runCompleted = true;
        closeReader();
      });
  };

  try {
    writeTextStderr(
      `texra chat plain mode. Agent: ${agent}. Model: ${model}. Type /help for commands.`,
    );
    reader.prompt();

    for await (const rawLine of reader) {
      const line = rawLine.trim();
      if (!line) {
        reader.prompt();
        continue;
      }

      if (line.startsWith('/')) {
        const { command, rest } = parseCommand(line);
        if (command === 'exit' || command === 'quit') {
          requestChatExit();
          break;
        }
        if (command === 'help') {
          printChatHelp();
        } else if (command === 'clear') {
          printClearScreen();
        } else if (command === 'agent') {
          if (runPromise) {
            writeTextStderr('The active session already owns its agent.');
          } else if (rest) {
            agent = rest;
            writeTextStderr(`Agent set to ${agent}.`);
          } else {
            writeTextStderr('Usage: /agent <name>');
          }
        } else if (command === 'model') {
          if (runPromise) {
            writeTextStderr('The active session already owns its model.');
          } else if (rest) {
            model = rest;
            writeTextStderr(`Model set to ${model}.`);
          } else {
            writeTextStderr('Usage: /model <name>');
          }
        } else if (command === 'yolo') {
          writeTextStderr(
            'Use --approval-policy yolo when starting texra chat to auto-approve approval gates. External inquiry prompts still require a human answer.',
          );
        } else {
          writeTextStderr(`Unknown command: /${command}`);
        }
        if (!runCompleted) reader.prompt();
        continue;
      }

      if (!runPromise) {
        startSession(line);
        reader.prompt();
        continue;
      }

      if (!streamId) {
        queueFollowUp(line);
        writeTextStderr(
          'The chat session is still starting. Follow-up queued.',
        );
        reader.prompt();
        continue;
      }

      queueFollowUp(line);
      if (!runCompleted) reader.prompt();
    }

    if (!stopRequested && runPromise && !runCompleted) {
      requestChatExit();
    }
    await followUpFlush;
    await runPromise;
    return { exitCode: runExitCode };
  } finally {
    closeReader();
    await runtimeHost.close();
  }
}

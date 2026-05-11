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
  flagValue,
  type CliContext,
} from '../runtime/cliContext';
import {
  hasCliApprovalDenied,
  installCliApprovalHandlers,
} from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform, setCliHelperModel } from '../runtime/initPlatform';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import {
  createCliLineReader,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';

export interface ChatResult {
  exitCode: number;
}

const DEFAULT_CHAT_AGENT = 'chat';

interface ChatSessionState {
  readerClosed: boolean;
  streamId: StreamTabId | undefined;
  runCompleted: boolean;
  runExitCode: CliExitCode;
  runPromise: Promise<void> | undefined;
  stopRequested: boolean;
  pendingFollowUps: string[];
  followUpFlush: Promise<void>;
  streamReadyForFollowUps: boolean;
}

function printChatHelp(): void {
  writeTextStderr(`Commands:
  /help            Show this help
  /agent <name>    Set the tool-use agent before the session starts
  /model <name>    Set the model before the session starts
  /yolo            Explain yolo approval mode
  /clear           Clear the terminal
  /exit, /quit     Exit chat`);
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

  let agent = flagValue(args, '--agent') ?? DEFAULT_CHAT_AGENT;
  let model = flagValue(args, '--model', '-m') ?? DEFAULT_AGENT_MODEL;
  const sessionContext = { ...chatContext, helperModel: model };

  await initCliPlatform(sessionContext);
  installCliApprovalHandlers(sessionContext);
  await loadAgents();

  const reader = createCliLineReader('texra> ');
  const session: ChatSessionState = {
    readerClosed: false,
    streamId: undefined,
    runCompleted: false,
    runExitCode: CliExitCode.Success,
    runPromise: undefined,
    stopRequested: false,
    pendingFollowUps: [],
    followUpFlush: Promise.resolve(),
    streamReadyForFollowUps: false,
  };
  const closeReader = (): void => {
    if (session.readerClosed) return;
    session.readerClosed = true;
    reader.close();
  };
  const interruptActiveSession = (): void => {
    if (!session.streamId) return;
    interruptActiveChildren(session.streamId);
    getInterruptible(session.streamId)?.interrupt();
  };

  const requestChatExit = (): void => {
    session.stopRequested = true;
    if (session.runPromise && !session.runCompleted) {
      interruptActiveSession();
      writeTextStderr(
        'Exit requested; waiting for the active session to stop.',
      );
    }
    closeReader();
  };

  const flushPendingFollowUps = (): void => {
    if (
      !session.streamId ||
      session.stopRequested ||
      session.pendingFollowUps.length === 0
    ) {
      return;
    }

    const lines = session.pendingFollowUps.splice(0);
    const waitForStreamActivation = !session.streamReadyForFollowUps;
    session.followUpFlush = session.followUpFlush
      .then(async () => {
        if (waitForStreamActivation) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          session.streamReadyForFollowUps = true;
        }
        for (const line of lines) {
          if (
            !session.streamId ||
            session.stopRequested ||
            session.runCompleted
          ) {
            return;
          }
          const result = await sendFollowUp(session.streamId, line);
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
    session.pendingFollowUps.push(line);
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

    const runtimeHost = createCliRuntimeHost(sessionContext);
    session.runPromise = executeAgent(config, undefined, {
      runtimeHost,
      enforceCategory: true,
      onStreamResolved: (resolvedStreamId) => {
        session.streamId = resolvedStreamId;
        session.streamReadyForFollowUps = false;
        if (session.stopRequested) {
          interruptActiveSession();
        } else {
          flushPendingFollowUps();
        }
      },
    })
      .then((result) => {
        session.runExitCode =
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
        session.runExitCode = CliExitCode.AgentError;
        writeTextStderr(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        session.runCompleted = true;
        closeReader();
        void runtimeHost.close();
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
          if (session.runPromise) {
            writeTextStderr('The active session already owns its agent.');
          } else if (rest) {
            agent = rest;
            writeTextStderr(`Agent set to ${agent}.`);
          } else {
            writeTextStderr('Usage: /agent <name>');
          }
        } else if (command === 'model') {
          if (session.runPromise) {
            writeTextStderr('The active session already owns its model.');
          } else if (rest) {
            model = rest;
            sessionContext.helperModel = model;
            await setCliHelperModel(model);
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
        if (!session.runCompleted) reader.prompt();
        continue;
      }

      if (!session.runPromise) {
        startSession(line);
        reader.prompt();
        continue;
      }

      if (!session.streamId) {
        queueFollowUp(line);
        writeTextStderr(
          'The chat session is still starting. Follow-up queued.',
        );
        reader.prompt();
        continue;
      }

      queueFollowUp(line);
      if (!session.runCompleted) reader.prompt();
    }

    if (!session.stopRequested && session.runPromise && !session.runCompleted) {
      requestChatExit();
    }
    await session.followUpFlush;
    await session.runPromise;
    return { exitCode: session.runExitCode };
  } finally {
    closeReader();
  }
}

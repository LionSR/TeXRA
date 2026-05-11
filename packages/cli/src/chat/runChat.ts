// Local imports - agent
import { loadAgents } from '@agent/index';
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { interruptActiveChildren } from '@agent/runtime/executionRegistry';
import { executeAgent } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { AgentLogger } from '@logger/AgentLogger';
import {
  MESSAGE_TYPES,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';

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
import { getCliModelAccess } from '../runtime/modelAccess';
import { createCliRuntimeHost } from '../runtime/runtimeHost';
import {
  createCliLineReader,
  writeRawStdout,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  ChatTerminalRenderer,
  type ChatToolDisplayMode,
} from './terminalRenderer';

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

function parseCommand(line: string): { command: string; rest: string } {
  const [command = '', ...rest] = line.slice(1).trim().split(/\s+/);
  return { command: command.toLowerCase(), rest: rest.join(' ') };
}

function parseToolDisplayMode(
  value: string | undefined,
): ChatToolDisplayMode | undefined {
  if (value == null) return 'minimal';
  if (value === 'grouped' || value === 'minimal' || value === 'hidden') {
    return value;
  }
  return undefined;
}

async function modelAvailable(
  model: string,
  renderer: ChatTerminalRenderer,
): Promise<boolean> {
  const access = await getCliModelAccess(model);
  if (!access) {
    renderer.error(
      `Unknown model: ${model}. Use texra models list to see available models.`,
    );
    return false;
  }
  if (!access.available) {
    renderer.error(
      `Model ${model} is unavailable: ${access.status}. Use /model <name> before sending a message.`,
    );
    return false;
  }
  return true;
}

function installChatResponsePrinter(session: ChatSessionState): {
  didPrint: () => boolean;
  dispose: () => void;
} {
  const store = AgentLogger.getStreamLogStore();
  const printedByEntry = new Map<string, string>();
  let printed = false;

  const dispose = store.onChange((streamId) => {
    if (streamId !== session.streamId) return;
    const log = store.get(streamId);
    if (!log) return;

    for (const entry of log.getRange(0)) {
      if (entry.messageType !== MESSAGE_TYPES.MODEL_RESPONSE) continue;
      const text = entry.text ?? '';
      const previous = printedByEntry.get(entry.id) ?? '';
      if (text.length <= previous.length) continue;
      writeRawStdout(text.slice(previous.length));
      printedByEntry.set(entry.id, text);
      printed = true;
    }
  });

  return {
    didPrint: () => printed,
    dispose,
  };
}

export async function runChat(context: CliContext): Promise<ChatResult> {
  const args = context.argv.slice(1);
  const chatContext = applyCliGlobalArgs(context, args);
  const initialToolDisplay = parseToolDisplayMode(
    flagValue(args, '--tool-display'),
  );
  let validationRenderer: ChatTerminalRenderer | undefined;
  const usageError = (message: string): ChatResult => {
    validationRenderer ??= new ChatTerminalRenderer(chatContext.colorEnabled);
    validationRenderer.error(message);
    return { exitCode: CliExitCode.Usage };
  };
  if (initialToolDisplay == null) {
    return usageError(
      'Unsupported --tool-display. Expected grouped, minimal, or hidden.',
    );
  }
  let toolDisplay: ChatToolDisplayMode = initialToolDisplay;
  if (chatContext.mode === 'headless') {
    return usageError(
      'texra chat requires an interactive terminal. Did you mean texra run?',
    );
  }
  if (chatContext.approvalPolicy === 'ask') {
    return usageError(
      'texra chat plain mode cannot prompt for approvals yet because chat input owns stdin. Use --approval-policy yolo for trusted local runs, --approval-policy never to fail closed, or texra run for workflow execution.',
    );
  }

  let agent = flagValue(args, '--agent') ?? DEFAULT_CHAT_AGENT;
  let model = flagValue(args, '--model', '-m') ?? DEFAULT_AGENT_MODEL;
  const currentMetadata = () => ({
    agent,
    model,
    cwd: chatContext.cwd,
    toolDisplay,
  });
  const currentSessionContext = (): CliContext => ({
    ...chatContext,
    helperModel: model,
    quietLogs: true,
  });

  await initCliPlatform(currentSessionContext());
  installCliApprovalHandlers(currentSessionContext());
  await loadAgents();

  const renderer = new ChatTerminalRenderer(
    chatContext.colorEnabled,
    toolDisplay,
  );
  const reader = createCliLineReader(renderer.prompt);
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
  const responsePrinter = installChatResponsePrinter(session);
  const disposeStatusListener = StreamStatusService.onDidChange((change) => {
    if (
      change.streamId !== session.streamId ||
      change.status !== STREAM_STATUS.WAITING ||
      session.stopRequested ||
      session.runCompleted
    ) {
      return;
    }
    if (responsePrinter.didPrint()) writeRawStdout('\n');
    reader.prompt();
  });
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
      renderer.warn('Exit requested; waiting for the active session to stop.');
    }
    closeReader();
  };
  const handleSigint = (): void => {
    if (session.stopRequested && session.runPromise && !session.runCompleted) {
      process.off('SIGINT', handleSigint);
      renderer.warn('Second Ctrl-C received; forcing process exit.');
      process.kill(process.pid, 'SIGINT');
      return;
    }
    requestChatExit();
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
            renderer.error('The chat session is no longer active.');
            closeReader();
            return;
          }
          if (result.status === 'queued') {
            renderer.warn(
              `Follow-up queued while session is ${result.reason}.`,
            );
          }
        }
      })
      .catch((error) => {
        renderer.error(error instanceof Error ? error.message : String(error));
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

    const runContext = currentSessionContext();
    const runtimeHost = createCliRuntimeHost(runContext);
    session.runPromise = executeAgent(config, undefined, {
      runtimeHost: {
        ...runtimeHost,
        emit(event, payload) {
          renderer.renderProgressEvent(event, payload);
          runtimeHost.emit(event, payload);
        },
      },
      enforceCategory: true,
      onStreamResolved: (resolvedStreamId) => {
        session.streamId = resolvedStreamId;
        session.streamReadyForFollowUps = false;
        if (session.stopRequested) {
          interruptActiveSession();
        } else if (session.pendingFollowUps.length > 0) {
          flushPendingFollowUps();
        } else {
          session.streamReadyForFollowUps = true;
        }
      },
    })
      .then((result) => {
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : result.status === 'error' && hasCliApprovalDenied(runContext)
            ? CliExitCode.ApprovalDenied
            : result.status === 'error'
              ? CliExitCode.AgentError
              : CliExitCode.Success;
        if (
          !responsePrinter.didPrint() &&
          result.category === 'toolUse' &&
          result.lastResponse
        ) {
          writeTextStdout(result.lastResponse);
        }
      })
      .catch((error) => {
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
        if (!session.stopRequested) {
          renderer.error(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        session.runCompleted = true;
        if (responsePrinter.didPrint()) writeRawStdout('\n');
        closeReader();
        void runtimeHost.close();
      });
  };

  try {
    process.on('SIGINT', handleSigint);
    renderer.printBanner(currentMetadata());
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
          renderer.printHelp();
        } else if (command === 'clear') {
          renderer.printClearScreen();
        } else if (command === 'agent') {
          if (session.runPromise) {
            renderer.warn('The active session already owns its agent.');
          } else if (rest) {
            agent = rest;
            renderer.success(`Agent set to ${agent}.`);
          } else {
            renderer.warn('Usage: /agent <name>');
          }
        } else if (command === 'model') {
          if (session.runPromise) {
            renderer.warn('The active session already owns its model.');
          } else if (rest) {
            if (await modelAvailable(rest, renderer)) {
              model = rest;
              await setCliHelperModel(model);
              renderer.success(`Model set to ${model}.`);
            }
          } else {
            renderer.warn('Usage: /model <name>');
          }
        } else if (command === 'tools') {
          const mode = parseToolDisplayMode(rest);
          if (mode == null) {
            renderer.warn('Usage: /tools <grouped|minimal|hidden>');
          } else {
            toolDisplay = mode;
            renderer.setToolDisplay(toolDisplay);
          }
        } else if (command === 'status') {
          renderer.printStatus(currentMetadata(), session.streamId);
        } else if (command === 'yolo') {
          renderer.info(
            'Use --approval-policy yolo when starting texra chat to auto-approve approval gates. External inquiry prompts still require a human answer.',
          );
        } else {
          renderer.warn(`Unknown command: /${command}`);
        }
        if (!session.runCompleted) reader.prompt();
        continue;
      }

      if (!session.runPromise) {
        if (!(await modelAvailable(model, renderer))) {
          reader.prompt();
          continue;
        }
        startSession(line);
        continue;
      }

      if (!session.streamId) {
        queueFollowUp(line);
        renderer.warn('The chat session is still starting. Follow-up queued.');
        reader.prompt();
        continue;
      }

      queueFollowUp(line);
    }

    if (!session.stopRequested && session.runPromise && !session.runCompleted) {
      requestChatExit();
    }
    await session.followUpFlush;
    await session.runPromise;
    return { exitCode: session.runExitCode };
  } finally {
    process.off('SIGINT', handleSigint);
    disposeStatusListener();
    responsePrinter.dispose();
    closeReader();
  }
}

// Local imports - agent
import { loadAgents } from '@agent/index';
import { type AgentConfigPayload } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { interruptActiveChildren } from '@agent/runtime/executionRegistry';
import { executeAgent } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';

// Local imports - auth
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { isOAuthProvider } from '@auth/sharedConfig';

// Local imports - common
import { toErrorMessage } from '@common/errors/errorMessage';
import { AgentLogger } from '@logger/AgentLogger';
import {
  MESSAGE_TYPES,
  STREAM_STATUS,
  type StreamTabId,
} from '@shared/schemas';

// Local imports - CLI runtime
import { type CliContext, type CliPromptRequest } from '../runtime/cliContext';
import {
  hasCliApprovalDenied,
  installCliApprovalHandlers,
} from '../runtime/approvalAdapter';
import { resolveChatDefaults } from '../runtime/chatDefaults';
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
import {
  getCliAuthProfile,
  signInCliSupabase,
  signOutCliSupabase,
} from '../runtime/supabaseAuth';

export interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
  /** `--tool-display` parsed enum value. */
  readonly toolDisplay: ChatToolDisplayMode;
}

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

interface MultilineDraftState {
  active: boolean;
  lines: string[];
}

interface PendingApprovalPrompt {
  request: CliPromptRequest;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

function parseCommand(line: string): { command: string; rest: string } {
  const [command = '', ...rest] = line.slice(1).trim().split(/\s+/);
  return { command: command.toLowerCase(), rest: rest.join(' ') };
}

interface SlashLoginArgs {
  readonly provider?: string;
  readonly noBrowser: boolean;
}

/** Slash-command parser for `/tools <mode>` — citty does not see slash args. */
function parseToolDisplaySlash(rest: string): ChatToolDisplayMode | undefined {
  const trimmed = rest.trim();
  if (trimmed === '') return 'minimal';
  if (trimmed === 'grouped' || trimmed === 'minimal' || trimmed === 'hidden') {
    return trimmed;
  }
  return undefined;
}

/** Minimal parser for the `/login [provider] [--no-browser]` slash command. */
function parseSlashLoginArgs(rest: string): SlashLoginArgs {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  let provider: string | undefined;
  let noBrowser = false;
  for (const token of tokens) {
    if (token === '--no-browser') {
      noBrowser = true;
    } else if (!token.startsWith('-') && !provider) {
      provider = token;
    }
  }
  return { provider, noBrowser };
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

function installChatResponsePrinter(
  session: ChatSessionState,
  renderer: ChatTerminalRenderer,
): {
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
      renderer.renderStreamLogEntry(entry);
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

export async function runChat(
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  const chatContext = context;
  if (chatContext.mode === 'headless') {
    const validationRenderer = new ChatTerminalRenderer(
      chatContext.colorEnabled,
    );
    validationRenderer.error(
      'texra chat requires an interactive terminal. Did you mean texra run?',
    );
    return { exitCode: CliExitCode.Usage };
  }
  let toolDisplay: ChatToolDisplayMode = init.toolDisplay;
  // Resolve defaults via workspace → user → last-used → built-in.
  // The platform isn't initialised yet, so the history tier reads the same
  // workspace storage that `initCliPlatform` will mount below.
  await initCliPlatform({ ...chatContext, quietLogs: true });
  const defaults = await resolveChatDefaults({
    cwd: chatContext.cwd,
    agentOverride: init.agentOverride,
    modelOverride: init.modelOverride,
  });
  let agent = defaults.agent;
  let model = defaults.model;
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
    approvalPrompt: (request) => askChatApprovalQuestion(request),
  });

  const startupContext = currentSessionContext();
  // Platform is already initialised above (before default resolution); this
  // call only re-aligns `helperModel` to the resolved model.
  await setCliHelperModel(model);
  installCliApprovalHandlers(startupContext);
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
  const multilineDraft: MultilineDraftState = {
    active: false,
    lines: [],
  };
  let pendingApprovalPrompt: PendingApprovalPrompt | undefined;
  const responsePrinter = installChatResponsePrinter(session, renderer);
  const disposeStatusListener = StreamStatusService.onDidChange((change) => {
    if (
      change.streamId !== session.streamId ||
      change.status !== STREAM_STATUS.WAITING ||
      session.stopRequested ||
      session.runCompleted ||
      pendingApprovalPrompt
    ) {
      return;
    }
    if (responsePrinter.didPrint()) writeRawStdout('\n');
    reader.prompt();
  });
  const closeReader = (): void => {
    if (pendingApprovalPrompt) {
      const pending = pendingApprovalPrompt;
      pendingApprovalPrompt = undefined;
      pending.reject(new Error('Chat input closed before approval answer.'));
    }
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

  const setReaderPrompt = (): void => {
    if (pendingApprovalPrompt) {
      reader.setPrompt(pendingApprovalPrompt.request.prompt);
      return;
    }
    reader.setPrompt(
      multilineDraft.active ? renderer.continuationPrompt : renderer.prompt,
    );
  };

  const resetMultilineDraft = (): void => {
    multilineDraft.active = false;
    multilineDraft.lines = [];
    setReaderPrompt();
  };

  const submitMessage = async (message: string): Promise<void> => {
    if (!session.runPromise) {
      if (!(await modelAvailable(model, renderer))) {
        reader.prompt();
        return;
      }
      startSession(message);
      return;
    }

    if (!session.streamId) {
      queueFollowUp(message);
      renderer.warn('The chat session is still starting. Follow-up queued.');
      reader.prompt();
      return;
    }

    queueFollowUp(message);
  };

  const askChatApprovalQuestion = (
    request: CliPromptRequest,
  ): Promise<string> => {
    if (pendingApprovalPrompt) {
      return Promise.reject(
        new Error('Another CLI approval prompt is already active.'),
      );
    }
    renderer.warn(request.summary);
    return new Promise<string>((resolve, reject) => {
      pendingApprovalPrompt = { request, resolve, reject };
      setReaderPrompt();
      reader.prompt();
    });
  };

  const resolvePendingApprovalPrompt = (answer: string): void => {
    const pending = pendingApprovalPrompt;
    if (!pending) return;
    pendingApprovalPrompt = undefined;
    pending.resolve(answer);
    setReaderPrompt();
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
        if (session.stopRequested || result.status !== 'error') {
          session.runExitCode = CliExitCode.Success;
        } else if (hasCliApprovalDenied(runContext)) {
          session.runExitCode = CliExitCode.ApprovalDenied;
        } else {
          session.runExitCode = CliExitCode.AgentError;
        }
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
      if (pendingApprovalPrompt) {
        resolvePendingApprovalPrompt(rawLine);
        continue;
      }

      const line = rawLine.trim();
      if (!line && !multilineDraft.active) {
        reader.prompt();
        continue;
      }

      if (line.startsWith('/') || line.startsWith('\\')) {
        const prefix = line[0] ?? '/';
        const { command, rest } = parseCommand(line);
        if (multilineDraft.active) {
          if (command === 'send') {
            const message = multilineDraft.lines.join('\n').trim();
            resetMultilineDraft();
            if (!message) {
              renderer.warn('Multiline draft is empty.');
              reader.prompt();
            } else {
              await submitMessage(message);
            }
            continue;
          }
          if (command === 'cancel') {
            resetMultilineDraft();
            renderer.warn('Multiline draft canceled.');
            reader.prompt();
            continue;
          }
        }
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
          const mode = parseToolDisplaySlash(rest);
          if (mode == null) {
            renderer.warn('Usage: /tools <grouped|minimal|hidden>');
          } else {
            toolDisplay = mode;
            renderer.setToolDisplay(toolDisplay);
          }
        } else if (command === 'multi') {
          multilineDraft.active = true;
          multilineDraft.lines = [];
          setReaderPrompt();
          renderer.info('Multiline draft started. Use /send or /cancel.');
        } else if (command === 'status') {
          renderer.printStatus(currentMetadata(), session.streamId);
        } else if (command === 'login') {
          const loginArgs = parseSlashLoginArgs(rest);
          const provider = loginArgs.provider ?? DEFAULT_OAUTH_PROVIDER;
          if (!isOAuthProvider(provider)) {
            renderer.warn('Usage: /login [github|google] [--no-browser]');
          } else {
            try {
              if (!loginArgs.noBrowser) {
                renderer.info(`Opening browser for TeXRA ${provider} sign-in.`);
              }
              const authSession = await signInCliSupabase({
                provider,
                openBrowser: !loginArgs.noBrowser,
                manualBrowserHint: '/login --no-browser',
                onAuthUrl: loginArgs.noBrowser
                  ? (url) => renderer.info(`Open this URL to sign in:\n${url}`)
                  : undefined,
              });
              renderer.success(`Signed in as ${authSession.account.label}.`);
            } catch (error) {
              renderer.error(toErrorMessage(error));
            }
          }
        } else if (command === 'logout') {
          try {
            await signOutCliSupabase();
            renderer.success('Signed out.');
          } catch (error) {
            renderer.error(toErrorMessage(error));
          }
        } else if (command === 'whoami') {
          try {
            const profile = await getCliAuthProfile();
            if (profile.authenticated) {
              renderer.info(
                `Signed in as ${profile.accountLabel ?? 'unknown'} (${profile.tier ?? 'unknown'}).`,
              );
            } else {
              renderer.info('Not signed in.');
            }
          } catch (error) {
            renderer.error(toErrorMessage(error));
          }
        } else if (command === 'yolo') {
          renderer.info(
            'Use --approval-policy yolo when starting texra chat to auto-approve approval gates. External inquiry prompts still require a human answer.',
          );
        } else {
          renderer.warn(`Unknown command: ${prefix}${command}`);
        }
        if (!session.runCompleted) reader.prompt();
        continue;
      }

      if (multilineDraft.active) {
        multilineDraft.lines.push(rawLine);
        reader.prompt();
        continue;
      }

      await submitMessage(line);
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

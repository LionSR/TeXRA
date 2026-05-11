// Local imports - agent
import {
  DEFAULT_AGENT_MODEL,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { loadAgents } from '@agent/index';
import { executeAgent } from '@agent/runtime/executeAgent';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
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
  /exit          Exit chat`);
}

function printClearScreen(): void {
  writeTextStderr('\u001B[2J\u001B[H');
}

function parseCommand(line: string): { command: string; rest: string } {
  const [command = '', ...rest] = line.slice(1).trim().split(/\s+/);
  return { command, rest: rest.join(' ') };
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

  await initCliPlatform(chatContext);
  installCliApprovalHandlers(chatContext);
  await loadAgents();

  const runtimeHost = createCliRuntimeHost(chatContext);
  const reader = createCliLineReader('texra> ');
  let agent = flagValue(args, '--agent') ?? DEFAULT_CHAT_AGENT;
  let model = flagValue(args, '--model', '-m') ?? DEFAULT_AGENT_MODEL;
  let streamId: StreamTabId | undefined;
  let runCompleted = false;
  let runExitCode: CliExitCode = CliExitCode.Success;
  let runPromise: Promise<void> | undefined;

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
        reader.close();
      });
  };

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
        reader.close();
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
        }
      } else if (command === 'model') {
        if (runPromise) {
          writeTextStderr('The active session already owns its model.');
        } else if (rest) {
          model = rest;
          writeTextStderr(`Model set to ${model}.`);
        }
      } else if (command === 'yolo') {
        writeTextStderr(
          'Use --approval-policy yolo when starting texra chat to auto-approve safe approval gates.',
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
      writeTextStderr('The chat session is still starting. Try again shortly.');
      reader.prompt();
      continue;
    }

    const result = await sendFollowUp(streamId, line);
    if (result.status === 'no_session') {
      writeTextStderr('The chat session is no longer active.');
      reader.close();
      break;
    }
    if (result.status === 'queued') {
      writeTextStderr(`Follow-up queued while session is ${result.reason}.`);
    }
    if (!runCompleted) reader.prompt();
  }

  await runPromise;
  await runtimeHost.close();
  return { exitCode: runExitCode };
}

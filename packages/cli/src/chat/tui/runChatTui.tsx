// `texra chat` entry point — single Ink-based session.
//
// The legacy line-based renderer was retired in favour of one canonical
// path: the Ink TUI runs for every interactive `texra chat` invocation, and
// non-TTY callers are pointed at `texra run` (which is what they actually
// want for piping/scripting).

import { render } from 'ink';
import PQueue from 'p-queue';

import { loadAgents } from '@agent/index';
import { type AgentConfigPayload } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { interruptActiveChildren } from '@agent/runtime/executionRegistry';
import { executeAgent } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { toErrorMessage } from '@common/errors/errorMessage';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { type CliContext } from '../../runtime/cliContext';
import { hasCliApprovalDenied } from '../../runtime/approvalAdapter';
import { resolveChatDefaults } from '../../runtime/chatDefaults';
import { CliExitCode } from '../../runtime/exitCodes';
import { initCliPlatform, setCliHelperModel } from '../../runtime/initPlatform';
import { createCliRuntimeHost } from '../../runtime/runtimeHost';
import { writeTextStderr } from '../../runtime/logSinks';
import { App } from './App';
import { registerBuiltinSlashCommands } from './commands/registerBuiltins';
import { loadInputHistory } from './history/inputHistory';
import { notify } from './notifications/terminalNotifier';
import { clearApprovals } from './state/approvalQueue';
import { cliState, resetCliState } from './state/cliState';
import { installTuiApprovals } from './state/subscribeApprovals';
import { wrapRuntimeHost } from './state/subscribeRuntimeHost';
import { subscribeStreamLog } from './state/subscribeStreamLog';
import { subscribeStreamStatus } from './state/subscribeStreamStatus';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';

export interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
}

interface TuiSession {
  streamId: StreamTabId | undefined;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

export async function runChat(
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  // `mode === 'headless'` already covers --print / CI / non-TTY stdin
  // (see cliContext.cliMode); stdout must also be a TTY for Ink to render,
  // and `TERM=dumb` strips the cursor controls Ink depends on (Ink would
  // mount and emit garbled output instead of a usable session).
  const isHeadless = context.mode === 'headless' || !process.stdout.isTTY;
  const dumbTerm = process.env.TERM === 'dumb';
  if (isHeadless || dumbTerm) {
    // Headless precedence: in CI (headless + TERM=dumb often co-occur) the
    // actionable advice is "use `texra run`", not "fix your TERM".
    writeTextStderr(
      isHeadless
        ? 'texra chat requires an interactive terminal (TTY stdin and stdout). For non-interactive runs, use `texra run`.'
        : 'texra chat needs a capable terminal — TERM=dumb strips the cursor controls Ink uses. For non-interactive runs, use `texra run`.',
    );
    return { exitCode: CliExitCode.Usage };
  }

  await initCliPlatform({ ...context, quietLogs: true });
  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    agentOverride: init.agentOverride,
    modelOverride: init.modelOverride,
  });
  const { agent, model } = defaults;
  await setCliHelperModel(model);

  cliState.sessionMeta.set({ agent, model, cwd: context.cwd });

  });
  await loadAgents();

  const inputHistory = await loadInputHistory();
  // Pre-register the slash commands the input palette uses.
  registerBuiltinSlashCommands();

  // DA1 sentinel discovery runs *before* Ink mounts so it owns the raw-mode
  // toggle exclusively — interleaving with Ink's own raw-mode lifecycle (set
  // when `useInput` mounts) caused capability discovery to flip raw mode off
  // ~250ms in, breaking input. Capability-gated notifications fall back to
  // BEL during this window (~250ms typical, hard 250ms cap on no DA1 reply).
  await discoverTerminalCapabilities({
    stdin: process.stdin,
    stdout: process.stdout,
  });

  const disposers: Array<() => void> = [];
  disposers.push(subscribeStreamLog());
  disposers.push(subscribeStreamStatus());

  const session: TuiSession = {
    streamId: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
  };

  const followUpQueue = new PQueue({ concurrency: 1 });

  const interruptActive = (): void => {
    clearApprovals();
    if (!session.streamId) return;
    interruptActiveChildren(session.streamId);
    getInterruptible(session.streamId)?.interrupt();
  };

  const startSession = (instruction: string): void => {
    const meta = cliState.sessionMeta.get();
    const currentAgent = meta.agent || agent;
    const currentModel = meta.model || model;
    const sessionContext = currentSessionContext(currentModel);
    const config: AgentConfigPayload = {
      agent: currentAgent,
      model: currentModel,
      instruction,
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: context.cwd,
    };
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);

    session.runPromise = setCliHelperModel(currentModel)
      .then(() =>
        executeAgent(config, undefined, {
          runtimeHost: wrapped,
          enforceCategory: true,
          onStreamResolved: (resolvedStreamId) => {
            session.streamId = resolvedStreamId;
            cliState.activeStreamId.set(resolvedStreamId);
            if (session.stopRequested) interruptActive();
          },
        }),
      )
      .then((result) => {
        if (session.stopRequested || result.status !== 'error') {
          session.runExitCode = CliExitCode.Success;
        } else if (hasCliApprovalDenied(sessionContext)) {
          session.runExitCode = CliExitCode.ApprovalDenied;
        } else {
          session.runExitCode = CliExitCode.AgentError;
        }
        notify({ kind: 'agentFinished' });
      })
      .catch((error: unknown) => {
        if (!session.stopRequested) {
          writeTextStderr(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
      })
      .finally(() => {
        session.runCompleted = true;
        void runtimeHost.close();
      });
  };

  const handleSubmit = (line: string): void => {
    if (!session.runPromise) {
      startSession(line);
      return;
    }
    // PRD success criterion: follow-ups must not be silently dropped when the
    // user submits before `onStreamResolved` populates `session.streamId`.
    // p-queue serializes work but doesn't have an "await predicate" primitive,
    // so the task itself waits for the stream id via a tiny poll loop.
    void followUpQueue.add(async () => {
      while (
        session.streamId === undefined &&
        !session.stopRequested &&
        !session.runCompleted
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (!session.streamId || session.stopRequested) return;
      const result = await sendFollowUp(session.streamId, line);
      if (result.status === 'no_session') {
        session.stopRequested = true;
      }
    });
  };

  // alternateScreen (Ink 7.0+) parks rendering on the terminal's alt buffer:
  // stray stderr writes from agent errors or approval prompts can't leak
  // into main-screen scrollback, and exit restores the user's pre-launch
  // terminal contents intact (no banner/conversation mixing with the shell
  // prompt the way main-screen mode did).
  const ink = render(<App onSubmit={handleSubmit} history={inputHistory} />, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    alternateScreen: true,
  });

  // Bridge SIGINT to a graceful interrupt (first tap) / process exit
  // (second tap). We detach the handler before exiting on the second tap so
  // Node's default termination path runs — re-`process.kill`-ing while the
  // listener is still installed would re-enter `handleSigint` and loop.
  let sigintCount = 0;
  const handleSigint = (): void => {
    sigintCount += 1;
    if (sigintCount >= 2) {
      process.off('SIGINT', handleSigint);
      ink.unmount();
      process.exit(130);
    }
    session.stopRequested = true;
    interruptActive();
  };
  process.on('SIGINT', handleSigint);

  // Auto-prompt when the active stream goes WAITING so the UI clearly
  // signals "your turn." Combined with the StatusBar pill, this replaces
  // the legacy reader.prompt() ergonomics.
  disposers.push(
    StreamStatusService.onDidChange((change) => {
      if (
        change.streamId === session.streamId &&
        change.status === STREAM_STATUS.WAITING &&
        !session.stopRequested
      ) {
        notify({ kind: 'agentFinished' });
      }
    }),
  );

  try {
    await ink.waitUntilExit();
  } finally {
    process.off('SIGINT', handleSigint);
    for (const dispose of disposers) dispose();
    await followUpQueue.onIdle();
    if (session.runPromise && !session.runCompleted) {
      session.stopRequested = true;
      interruptActive();
    }
    await session.runPromise;
    resetCliState();
  }
  return { exitCode: session.runExitCode };
}

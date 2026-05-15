// Ink-mounted chat session per docs/prd/cli-tui-ink.
//
// This is the new TUI entry that the `--tui` flag mounts; the legacy
// `runChat.ts` path is still the default until Phase 6. We intentionally
// share as much as possible with the legacy path — platform init, default
// resolution, and the agent runtime host — and swap the rendering surface
// (Ink), approval UI, and follow-up queue.

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
import { type ChatResult, type RunChatInit } from '../runChat';
import { App } from './App';
import { notify } from './notifications/terminalNotifier';
import { clearApprovals } from './state/approvalQueue';
import { cliState, resetCliState } from './state/cliState';
import { installTuiApprovals } from './state/subscribeApprovals';
import { wrapRuntimeHost } from './state/subscribeRuntimeHost';
import { subscribeStreamLog } from './state/subscribeStreamLog';
import { subscribeStreamStatus } from './state/subscribeStreamStatus';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';

interface TuiSession {
  streamId: StreamTabId | undefined;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

export async function runChatTui(
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  if (context.mode === 'headless') {
    writeTextStderr(
      'texra chat --tui requires an interactive terminal. Did you mean texra run?',
    );
    return { exitCode: CliExitCode.Usage };
  }

  // Streaming-text fallback per docs/prd/cli-tui-ink/20-implementation §13:
  // when stdout is piped but stdin is TTY, Ink chrome can't render usefully —
  // delegate back to the legacy plain renderer so `texra chat --tui | tee` and
  // similar shapes keep working. Phase 4 lifts this into a dedicated mode
  // that still flows through the React tree but writes plain ANSI to stdout.
  if (!process.stdout.isTTY) {
    const { runChat } = await import('../runChat');
    return runChat(context, init);
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

  const sessionContext: CliContext = {
    ...context,
    helperModel: model,
    quietLogs: true,
  };
  // Phase 2 replaces the legacy stderr-prompt approval adapter with the
  // typed dispatch: events flow into the modal queue, modal calls back
  // through the original resolvers (see state/subscribeApprovals.ts).
  // The legacy adapter only stays on the `!--tui` path now.
  await loadAgents();

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
    const config: AgentConfigPayload = {
      agent,
      model,
      instruction,
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: context.cwd,
    };
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);

    session.runPromise = executeAgent(config, undefined, {
      runtimeHost: wrapped,
      enforceCategory: true,
      onStreamResolved: (resolvedStreamId) => {
        session.streamId = resolvedStreamId;
        cliState.activeStreamId.set(resolvedStreamId);
        if (session.stopRequested) interruptActive();
      },
    })
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

  const ink = render(<App onSubmit={handleSubmit} />, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
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

// Node imports
import { createRequire } from 'node:module';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliToolUseResumeResolution } from '@cli/runtime/sessionResume';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  chatAgentSupportsDelegation: vi.fn(),
  chatToolUseAgentUsageError: vi.fn(),
  cleanupTerminalModes: vi.fn(),
  createChatSessionController: vi.fn(),
  discoverTerminalCapabilities: vi.fn(),
  handOffCliShutdownSignalHandlers: vi.fn(),
  initCliPlatform: vi.fn(),
  initInteractiveCliPlatform: vi.fn(),
  installTerminalRestoreOnExit: vi.fn(),
  installTerminalTitleUpdates: vi.fn(),
  loadInputHistory: vi.fn(),
  maybeRunCliOnboarding: vi.fn(),
  onSkillSelect: undefined as
    | ((selection: { name: string; activationPrompt: string }) => void)
    | undefined,
  registerBuiltinSlashCommands: vi.fn(),
  render: vi.fn(),
  resolveChatDefaults: vi.fn(),
  restoreTuiInputModes: vi.fn(),
  runCliPlatformShutdownSequence: vi.fn(),
  selectCliRunnableModel: vi.fn(),
  setCliHelperModel: vi.fn(),
  startRootRun: vi.fn(),
  subscribeStreamLog: vi.fn(),
  subscribeStreamStatus: vi.fn(),
  supportsTerminalJobControl: vi.fn(),
  terminalTitleDispose: vi.fn(),
  terminalTitleResume: vi.fn(),
  terminalTitleSuspend: vi.fn(),
  tuiOutputStreamForColor: vi.fn(),
  unmount: vi.fn(),
  waitUntilExit: vi.fn(),
}));

// Ink is a CLI-workspace dependency rather than a root dependency. Resolve its
// public entry point from that workspace before runChatTui.tsx is imported.
vi.doMock(cliRequire.resolve('ink'), () => ({
  Box: vi.fn(),
  Static: vi.fn(),
  Text: vi.fn(),
  kittyFlags: { disambiguateEscapeCodes: 1 },
  render: mocks.render,
  useApp: vi.fn(),
  useInput: vi.fn(),
  usePaste: vi.fn(),
  useStdin: vi.fn(),
  useWindowSize: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  handOffCliShutdownSignalHandlers: mocks.handOffCliShutdownSignalHandlers,
  initCliPlatform: mocks.initCliPlatform,
  initInteractiveCliPlatform: mocks.initInteractiveCliPlatform,
  runCliPlatformShutdownSequence: mocks.runCliPlatformShutdownSequence,
  setCliHelperModel: mocks.setCliHelperModel,
}));

vi.mock('@cli/onboarding/runOnboarding', () => ({
  maybeRunCliOnboarding: mocks.maybeRunCliOnboarding,
}));

vi.mock('@cli/runtime/chatDefaults', () => ({
  resolveChatDefaults: mocks.resolveChatDefaults,
}));

vi.mock('@cli/runtime/modelAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/modelAccess')>();
  return { ...actual, selectCliRunnableModel: mocks.selectCliRunnableModel };
});

vi.mock(
  '@cli/chat/tui/commands/handlers/agentModelCommands',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@cli/chat/tui/commands/handlers/agentModelCommands')
      >();
    return {
      ...actual,
      chatAgentSupportsDelegation: mocks.chatAgentSupportsDelegation,
      chatToolUseAgentUsageError: mocks.chatToolUseAgentUsageError,
    };
  },
);

vi.mock('@cli/chat/tui/history/inputHistory', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/chat/tui/history/inputHistory')>();
  return { ...actual, loadInputHistory: mocks.loadInputHistory };
});

vi.mock('@cli/chat/tui/state/terminalCapabilities', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@cli/chat/tui/state/terminalCapabilities')
    >();
  return {
    ...actual,
    discoverTerminalCapabilities: mocks.discoverTerminalCapabilities,
  };
});

vi.mock('@cli/chat/tui/terminalCleanup', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/chat/tui/terminalCleanup')>();
  return {
    ...actual,
    cleanupTerminalModes: mocks.cleanupTerminalModes,
    installTerminalRestoreOnExit: mocks.installTerminalRestoreOnExit,
    installTerminalTitleUpdates: mocks.installTerminalTitleUpdates,
    restoreTuiInputModes: mocks.restoreTuiInputModes,
    supportsTerminalJobControl: mocks.supportsTerminalJobControl,
  };
});

vi.mock('@cli/chat/tui/render/noColorOutput', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/chat/tui/render/noColorOutput')>();
  return {
    ...actual,
    tuiOutputStreamForColor: mocks.tuiOutputStreamForColor,
  };
});

vi.mock('@cli/chat/tui/state/subscribeStreamLog', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@cli/chat/tui/state/subscribeStreamLog')
    >();
  return { ...actual, subscribeStreamLog: mocks.subscribeStreamLog };
});

vi.mock('@cli/chat/tui/state/subscribeStreamStatus', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@cli/chat/tui/state/subscribeStreamStatus')
    >();
  return { ...actual, subscribeStreamStatus: mocks.subscribeStreamStatus };
});

vi.mock('@cli/chat/tui/commands/registerBuiltins', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@cli/chat/tui/commands/registerBuiltins')
    >();
  return {
    ...actual,
    registerBuiltinSlashCommands: mocks.registerBuiltinSlashCommands,
  };
});

vi.mock('@cli/chat/chatSessionController', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/chat/chatSessionController')>();
  return {
    ...actual,
    createChatSessionController: mocks.createChatSessionController,
  };
});

const INTERACTIVE_CONTEXT: CliContext = createTestCliContext({
  cwd: '/tmp/texra-chat',
  mode: 'interactive',
  outputFormat: 'text',
  approvalPolicy: 'ask',
  apiMode: 'personal',
  stdoutIsTty: true,
  termIsDumb: false,
  stderrIsTty: true,
  stdoutColorEnabled: false,
  stderrColorEnabled: false,
  commandName: 'texra',
  version: '0.0.0',
  resourcesPath: '/tmp/resources',
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('runChat signal ownership wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callOrder.length = 0;

    mocks.initCliPlatform.mockImplementation(async () => {
      mocks.callOrder.push('initCliPlatform');
    });
    mocks.initInteractiveCliPlatform.mockImplementation(async () => {
      mocks.callOrder.push('initInteractiveCliPlatform');
    });
    mocks.handOffCliShutdownSignalHandlers.mockImplementation(() => {
      mocks.callOrder.push('handOffCliShutdownSignalHandlers');
    });
    mocks.runCliPlatformShutdownSequence.mockResolvedValue(undefined);
    mocks.setCliHelperModel.mockResolvedValue(undefined);
    mocks.maybeRunCliOnboarding.mockResolvedValue({
      configured: false,
      declined: false,
    });
    mocks.resolveChatDefaults.mockResolvedValue({
      agent: 'assistant',
      agentSource: 'default',
      model: 'gpt-test',
      modelSource: 'default',
    });
    mocks.chatToolUseAgentUsageError.mockReturnValue(undefined);
    mocks.chatAgentSupportsDelegation.mockReturnValue(false);
    mocks.selectCliRunnableModel.mockResolvedValue({ model: 'gpt-test' });
    mocks.loadInputHistory.mockResolvedValue({
      at: vi.fn(),
      length: vi.fn(() => 0),
      push: vi.fn(async () => undefined),
      reverseFind: vi.fn(),
    });
    mocks.discoverTerminalCapabilities.mockResolvedValue({
      bracketedPaste: false,
      discovered: false,
      graphemeClusters: false,
      kittyKeyboard: false,
      oscColorReports: false,
    });
    mocks.installTerminalRestoreOnExit.mockReturnValue(() => undefined);
    mocks.installTerminalTitleUpdates.mockReturnValue({
      dispose: mocks.terminalTitleDispose,
      resume: mocks.terminalTitleResume,
      suspend: mocks.terminalTitleSuspend,
    });
    mocks.subscribeStreamLog.mockReturnValue(() => undefined);
    mocks.subscribeStreamStatus.mockReturnValue(() => undefined);
    mocks.onSkillSelect = undefined;
    mocks.registerBuiltinSlashCommands.mockImplementation(
      (options: {
        readonly onSkillSelect?: (selection: {
          name: string;
          activationPrompt: string;
        }) => void;
      }) => {
        mocks.onSkillSelect = options.onSkillSelect;
      },
    );
    mocks.supportsTerminalJobControl.mockReturnValue(false);
    mocks.tuiOutputStreamForColor.mockImplementation((stream) => stream);
    mocks.createChatSessionController.mockReturnValue({
      admitInterruptedFollowUp: vi.fn(() => ({ kind: 'not_interrupted' })),
      canStartRootRun: vi.fn(() => true),
      clearInterruptedRecovery: vi.fn(),
      resume: vi.fn(async () => undefined),
      startRootRun: mocks.startRootRun,
      stop: vi.fn(),
      tryResumeStream: vi.fn(async () => false),
    });
    mocks.render.mockImplementation(() => {
      mocks.callOrder.push('ink.render');
      return {
        clear: vi.fn(),
        repaint: vi.fn(),
        rerender: vi.fn(),
        unmount: mocks.unmount,
        waitUntilExit: mocks.waitUntilExit,
      };
    });
  });

  it('initializes the interactive platform and hands signal ownership to the mounted TUI', async () => {
    const targetSignals = ['SIGINT', 'SIGTERM', 'SIGTSTP', 'SIGCONT'] as const;
    type TargetSignal = (typeof targetSignals)[number];
    const baselineListeners = new Map(
      targetSignals.map(
        (signal) => [signal, process.listeners(signal)] as const,
      ),
    );
    const tuiListeners = new Map<TargetSignal, (...args: unknown[]) => void>();
    const observeNewListener = (
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): void => {
      if (!targetSignals.includes(event as TargetSignal)) return;
      mocks.callOrder.push(`process.on:${String(event)}`);
      tuiListeners.set(event as TargetSignal, listener);
    };
    const waitStarted = deferred();
    const exitTui = deferred();
    let onSubmit:
      ((line: string, mediaFiles?: readonly string[]) => void) | undefined;
    mocks.waitUntilExit.mockImplementation(() => {
      waitStarted.resolve();
      return exitTui.promise;
    });
    mocks.render.mockImplementationOnce(
      (element: {
        readonly props?: { readonly onSubmit?: typeof onSubmit };
      }) => {
        mocks.callOrder.push('ink.render');
        onSubmit = element.props?.onSubmit;
        return {
          clear: vi.fn(),
          repaint: vi.fn(),
          rerender: vi.fn(),
          unmount: mocks.unmount,
          waitUntilExit: mocks.waitUntilExit,
        };
      },
    );
    process.on('newListener', observeNewListener);
    mocks.supportsTerminalJobControl.mockReturnValue(true);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code) => {
      mocks.callOrder.push(`process.exit:${code}`);
      return undefined as never;
    }) as typeof process.exit);

    const agents = await import('@agent/index');
    const loadAgentsSpy = vi
      .spyOn(agents, 'loadAgents')
      .mockResolvedValue(undefined);
    const getVisibleAgentsSpy = vi
      .spyOn(agents, 'getVisibleAgents')
      .mockReturnValue([]);
    const { runChat } = await import('@cli/chat/tui/runChatTui');
    const runPromise = runChat(INTERACTIVE_CONTEXT, {});

    try {
      await Promise.race([
        waitStarted.promise,
        runPromise.then(() => {
          throw new Error('runChat returned before the Ink TUI mounted');
        }),
      ]);

      expect(mocks.initInteractiveCliPlatform).toHaveBeenCalledWith({
        ...INTERACTIVE_CONTEXT,
        quietLogs: true,
      });
      expect(mocks.initCliPlatform).not.toHaveBeenCalled();
      expect(mocks.handOffCliShutdownSignalHandlers).toHaveBeenCalledTimes(1);
      expect(mocks.callOrder).toEqual([
        'initInteractiveCliPlatform',
        'ink.render',
        'handOffCliShutdownSignalHandlers',
        'process.on:SIGINT',
        'process.on:SIGTERM',
        'process.on:SIGTSTP',
        'process.on:SIGCONT',
      ]);

      for (const signal of targetSignals) {
        const listener = tuiListeners.get(signal);
        expect(listener).toBeTypeOf('function');
        expect(process.listeners(signal)).toEqual([
          ...(baselineListeners.get(signal) ?? []),
          listener,
        ]);
      }

      tuiListeners.get('SIGTSTP')?.();
      expect(mocks.terminalTitleSuspend).toHaveBeenCalledTimes(1);
      expect(mocks.cleanupTerminalModes).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGSTOP');

      tuiListeners.get('SIGCONT')?.();
      expect(mocks.restoreTuiInputModes).toHaveBeenCalledWith({
        kittyKeyboard: false,
      });
      expect(mocks.terminalTitleResume).toHaveBeenCalledTimes(1);

      onSubmit?.('check the ordinary case', []);
      await vi.waitFor(() => expect(mocks.startRootRun).toHaveBeenCalled());
      expect(mocks.startRootRun).toHaveBeenCalledWith({
        agent: 'assistant',
        model: 'gpt-test',
        instruction: 'check the ordinary case',
        agentCategory: 'toolUse',
        workingDirectory: '/tmp/texra-chat',
      });

      mocks.callOrder.length = 0;
      mocks.terminalTitleSuspend.mockImplementationOnce(() => {
        mocks.callOrder.push('terminalTitle.suspend');
      });
      mocks.unmount.mockImplementationOnce(() => {
        mocks.callOrder.push('ink.unmount');
        exitTui.resolve();
      });
      mocks.cleanupTerminalModes.mockImplementationOnce(() => {
        mocks.callOrder.push('cleanupTerminalModes');
      });
      tuiListeners.get('SIGTERM')?.();
      expect(mocks.callOrder.slice(0, 3)).toEqual([
        'terminalTitle.suspend',
        'ink.unmount',
        'cleanupTerminalModes',
      ]);

      await expect(runPromise).resolves.toEqual({
        exitCode: CliExitCode.Success,
      });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
      for (const signal of targetSignals) {
        expect(process.listeners(signal)).toEqual(
          baselineListeners.get(signal) ?? [],
        );
      }
    } finally {
      exitTui.resolve();
      await runPromise.catch(() => undefined);
      process.off('newListener', observeNewListener);
      for (const [signal, listener] of tuiListeners) {
        if (!(baselineListeners.get(signal) ?? []).includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
      loadAgentsSpy.mockRestore();
      getVisibleAgentsSpy.mockRestore();
      kill.mockRestore();
      exit.mockRestore();
    }
  });

  it('constructs the exact initial run configuration for a resumed team', async () => {
    const exitTui = deferred();
    let onSubmit:
      ((line: string, mediaFiles?: readonly string[]) => void) | undefined;
    mocks.waitUntilExit.mockReturnValue(exitTui.promise);
    mocks.render.mockImplementationOnce(
      (element: {
        readonly props?: { readonly onSubmit?: typeof onSubmit };
      }) => {
        onSubmit = element.props?.onSubmit;
        return {
          clear: vi.fn(),
          repaint: vi.fn(),
          rerender: vi.fn(),
          unmount: mocks.unmount,
          waitUntilExit: mocks.waitUntilExit,
        };
      },
    );
    const agents = await import('@agent/index');
    const loadAgentsSpy = vi
      .spyOn(agents, 'loadAgents')
      .mockResolvedValue(undefined);
    const getVisibleAgentsSpy = vi
      .spyOn(agents, 'getVisibleAgents')
      .mockReturnValue([]);
    const delegationAgentScope = {
      workflowAgentKeys: ['builtInWorkflow:physicsReviewer'],
      toolUseAgentKeys: ['builtInToolUse:orchestrator'],
    } as const;
    const mediaFiles = ['/tmp/diagram.png'];
    const activationPrompt = '<skill_activation>hidden</skill_activation>';
    const streamId = 'stream-resume' as StreamTabId;
    const resolution: CliToolUseResumeResolution = {
      ...createToolUseResumeData({
        executionId: 'exec-resume' as ExecutionId,
        streamId,
        agentConfig: AgentConfigSchema.parse({
          agent: 'orchestrator',
          model: 'gpt-test',
          agentCategory: 'toolUse',
          cliMultiAgentPresetId: 'physicist',
          delegationAgentScope,
        }),
      }),
    };
    const { runChat } = await import('@cli/chat/tui/runChatTui');
    const runPromise = runChat(INTERACTIVE_CONTEXT, {
      initialResume: {
        id: 'exec-resume' as ExecutionId,
        resolution,
      },
    });

    try {
      await vi.waitFor(() => {
        expect(onSubmit).toBeTypeOf('function');
        expect(mocks.onSkillSelect).toBeTypeOf('function');
      });
      mocks.onSkillSelect?.({ name: 'proof-audit', activationPrompt });
      onSubmit?.('', mediaFiles);

      await vi.waitFor(() => expect(mocks.startRootRun).toHaveBeenCalled());
      mediaFiles.push('/tmp/late.png');
      expect(mocks.startRootRun).toHaveBeenCalledWith({
        agent: 'assistant',
        model: 'gpt-test',
        instruction: [
          activationPrompt,
          '<user_request>',
          '',
          '</user_request>',
        ].join('\n'),
        displayInstruction: '',
        agentCategory: 'toolUse',
        workingDirectory: '/tmp/texra-chat',
        mediaFiles: ['/tmp/diagram.png'],
        cliMultiAgentPresetId: 'physicist',
        delegationAgentScope,
      });
    } finally {
      exitTui.resolve();
      await runPromise;
      loadAgentsSpy.mockRestore();
      getVisibleAgentsSpy.mockRestore();
    }
  });
});

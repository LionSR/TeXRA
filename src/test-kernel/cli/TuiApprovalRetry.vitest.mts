import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookupApiKey: vi.fn(),
  notify: vi.fn(),
  secrets: {},
  setCliApiMode: vi.fn(async () => undefined),
  setCliCodexSubscription: vi.fn(async () => undefined),
  triggerRetry: vi.fn(),
  cancelRetry: vi.fn(),
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: mocks.notify,
}));

vi.mock('@cli/runtime/apiAccessMode', async (importActual) => {
  const actual =
    await importActual<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    setCliApiMode: mocks.setCliApiMode,
  };
});

vi.mock('@cli/chat/tui/state/codexSubscription', () => ({
  setCliCodexSubscription: mocks.setCliCodexSubscription,
}));

vi.mock('@agent/runtime/runCoordinators', () => ({
  runCoordinatorBridge: {
    triggerRetry: mocks.triggerRetry,
    cancelRetry: mocks.cancelRetry,
  },
}));

vi.mock('@cli/runtime/approvalAdapter', () => {
  interface RetryPayloadForMock {
    errorMessage?: string;
    errorDetails?: {
      exhaustionReason?:
        'relay-limit' | 'upstream-credit' | 'chatgpt-subscription';
      isRelayError?: boolean;
    };
  }

  const isChatGptSubscriptionRetry = (payload: RetryPayloadForMock) =>
    payload.errorDetails?.exhaustionReason === 'chatgpt-subscription';
  const isRelayMonthlyLimitMessage = (message?: string) =>
    message?.toLowerCase().includes('monthly spending limit') === true;

  return {
    approvalPromptAllowed: (context: {
      approvalPolicy: string;
      mode: string;
    }) => context.approvalPolicy === 'ask' && context.mode === 'interactive',
    humanInputDenialFeedback: () => 'Denied by CLI approval policy.',
    handleCliAgentProposalDecision: vi.fn(async () => true),
    immediateDecision: (context: { approvalPolicy: string }) => {
      if (context.approvalPolicy === 'yolo') return { accepted: true };
      if (context.approvalPolicy === 'ask') return undefined;
      return { accepted: false, userMessage: 'Denied by CLI approval policy.' };
    },
    immediateDecisionForApproval: (
      _event: string,
      _payload: unknown,
      context: { approvalPolicy: string; mode: string },
    ) => {
      if (context.approvalPolicy === 'ask' && context.mode === 'interactive') {
        return undefined;
      }
      if (context.approvalPolicy === 'yolo') return { accepted: true };
      return { accepted: false, userMessage: 'Denied by CLI approval policy.' };
    },
    isCliApiSwitchableRetry: (payload: RetryPayloadForMock) =>
      isChatGptSubscriptionRetry(payload) ||
      (payload.errorDetails?.exhaustionReason !== undefined &&
        (payload.errorDetails?.isRelayError === true ||
          isRelayMonthlyLimitMessage(payload.errorMessage))),
    isCliChatGptSubscriptionRetry: isChatGptSubscriptionRetry,
    markApprovalDenied: vi.fn(),
  };
});

vi.mock('@model/apiProviders', async (importActual) => {
  const actual = await importActual<typeof import('@model/apiProviders')>();
  return {
    ...actual,
    lookupApiKey: mocks.lookupApiKey,
  };
});

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: mocks.secrets }),
}));

import {
  clearApprovals,
  currentApproval,
} from '@cli/chat/tui/state/approvalQueue';
import { installTuiApprovals } from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';

function context(): CliContext {
  return {
    cwd: '/work',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    colorEnabled: false,
    version: 'test',
    resourcesPath: '/resources',
  };
}

function host(): CliRuntimeHost {
  return {
    emit: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as CliRuntimeHost;
}

function relayRetry(params: {
  streamId: string;
  provider?: string;
  message?: string;
}): ProgressEventPayloads['showRetryRequest'] {
  return {
    streamId: params.streamId,
    operation: 'model request',
    errorMessage: params.message ?? 'Relay monthly limit reached.',
    errorDetails: {
      message: params.message ?? 'Relay monthly limit reached.',
      exhaustionReason: 'relay-limit',
      isRelayError: true,
      ...(params.provider ? { provider: params.provider } : {}),
    },
  } as ProgressEventPayloads['showRetryRequest'];
}

function chatGptSubscriptionRetry(
  streamId: string,
): ProgressEventPayloads['showRetryRequest'] {
  return {
    streamId,
    operation: 'model request',
    errorMessage: 'ChatGPT subscription usage limit reached.',
    errorDetails: {
      message: 'ChatGPT subscription usage limit reached.',
      exhaustionReason: 'chatgpt-subscription',
      provider: 'openai',
    },
  } as ProgressEventPayloads['showRetryRequest'];
}

afterEach(() => {
  clearApprovals();
  mocks.lookupApiKey.mockReset();
  mocks.notify.mockReset();
  mocks.setCliApiMode.mockClear();
  mocks.setCliCodexSubscription.mockClear();
  mocks.triggerRetry.mockClear();
  mocks.cancelRetry.mockClear();
});

describe('TUI retry approvals', () => {
  it('auto-switches provider-less relay retries when any personal key exists', async () => {
    const fallbackProvider =
      API_PROVIDERS.find((provider) => provider !== 'openai') ??
      API_PROVIDERS[0];
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === fallbackProvider ? 'sk-test' : undefined,
    );

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit('showRetryRequest', relayRetry({ streamId: 's1' }));

      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
        expect(mocks.triggerRetry).toHaveBeenCalledWith('s1', undefined);
      });
      expect(currentApproval.get()).toBeUndefined();
      expect(mocks.lookupApiKey.mock.calls.map((call) => call[1])).toContain(
        fallbackProvider,
      );
    } finally {
      unbind();
    }
  });

  it('falls back to the retry modal when API key lookup fails', async () => {
    mocks.lookupApiKey.mockRejectedValue(new Error('keychain unavailable'));

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      const retry = relayRetry({ streamId: 's2', provider: 'openai' });
      runtimeHost.emit('showRetryRequest', retry);

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 's2' },
        });
      });
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });

  it('does not auto-switch when a retry provider is not an API provider', async () => {
    mocks.lookupApiKey.mockResolvedValue('sk-test');

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      const retry = relayRetry({
        streamId: 'unknown-provider',
        provider: 'custom-provider',
      });
      runtimeHost.emit('showRetryRequest', retry);

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 'unknown-provider' },
        });
      });
      expect(mocks.lookupApiKey).not.toHaveBeenCalled();
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });

  it('auto-switches relay retries detected by monthly-limit message fallback', async () => {
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === 'openai' ? 'sk-openai' : undefined,
    );

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit('showRetryRequest', {
        streamId: 'message-fallback',
        operation: 'model request',
        errorMessage: 'Monthly spending limit reached.',
        errorDetails: {
          message: 'Monthly spending limit reached.',
          exhaustionReason: 'relay-limit',
          isRelayError: false,
          provider: 'openai',
        },
      } as ProgressEventPayloads['showRetryRequest']);

      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
        expect(mocks.triggerRetry).toHaveBeenCalledWith(
          'message-fallback',
          undefined,
        );
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      unbind();
    }
  });

  it('auto-switches ChatGPT subscription retries to an OpenAI API key', async () => {
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === 'openai' ? 'sk-openai' : undefined,
    );

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit('showRetryRequest', chatGptSubscriptionRetry('s3'));

      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
        expect(mocks.setCliCodexSubscription).toHaveBeenCalledWith(false);
        expect(mocks.triggerRetry).toHaveBeenCalledWith('s3', undefined);
      });
      expect(currentApproval.get()).toBeUndefined();
      expect(mocks.lookupApiKey.mock.calls.map((call) => call[1])).toEqual([
        'openai',
      ]);
    } finally {
      unbind();
    }
  });

  it('invalidates pre-queue retry lookups when approvals are cleared', async () => {
    let resolveLookup: ((value: string | undefined) => void) | undefined;
    mocks.lookupApiKey.mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({ streamId: 'interrupted', provider: 'openai' }),
      );
      clearApprovals();
      expect(mocks.cancelRetry).toHaveBeenCalledWith('interrupted');

      resolveLookup?.('sk-after-interrupt');
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.setCliApiMode).not.toHaveBeenCalled();
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
      expect(mocks.cancelRetry).toHaveBeenCalledTimes(1);
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      unbind();
    }
  });

  it('invalidates pre-queue retry lookups when approvals are unbound', async () => {
    let resolveLookup: ((value: string | undefined) => void) | undefined;
    mocks.lookupApiKey.mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    runtimeHost.emit(
      'showRetryRequest',
      relayRetry({ streamId: 'unbound', provider: 'openai' }),
    );
    unbind();

    resolveLookup?.('sk-after-unbind');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.triggerRetry).not.toHaveBeenCalled();
    expect(mocks.cancelRetry).not.toHaveBeenCalled();
    expect(currentApproval.get()).toBeUndefined();
  });

  it('cancels an active retry modal when approvals are cleared', async () => {
    mocks.lookupApiKey.mockResolvedValue(undefined);

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({ streamId: 'modal-interrupt', provider: 'openai' }),
      );

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 'modal-interrupt' },
        });
      });

      clearApprovals();
      expect(mocks.cancelRetry).toHaveBeenCalledWith('modal-interrupt');
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      unbind();
    }
  });

  it('ignores stale auto-switch lookups after a newer retry replaces them', async () => {
    let resolveFirstLookup: ((value: string | undefined) => void) | undefined;
    mocks.lookupApiKey
      .mockImplementationOnce(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolveFirstLookup = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'first retry',
        }),
      );
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'second retry',
        }),
      );

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { errorMessage: 'second retry' },
        });
      });

      resolveFirstLookup?.('sk-stale');
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.setCliApiMode).not.toHaveBeenCalled();
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });

  it('clears an older retry modal when a newer retry auto-switches', async () => {
    mocks.lookupApiKey
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('sk-new');

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'first retry',
        }),
      );
      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { errorMessage: 'first retry' },
        });
      });

      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'second retry',
        }),
      );

      await vi.waitFor(() => {
        expect(mocks.triggerRetry).toHaveBeenCalledWith(
          'same-stream',
          undefined,
        );
        expect(currentApproval.get()).toBeUndefined();
      });
    } finally {
      unbind();
    }
  });

  it('replaces an older retry modal when a newer retry also needs input', async () => {
    mocks.lookupApiKey.mockResolvedValue(undefined);

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'first retry',
        }),
      );
      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { errorMessage: 'first retry' },
        });
      });

      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'second retry',
        }),
      );

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { errorMessage: 'second retry' },
        });
      });
      expect(mocks.cancelRetry).not.toHaveBeenCalled();
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });

  it('does not let a stale auto-switch failure cancel a newer retry', async () => {
    let rejectFirstModeSwitch: ((error: Error) => void) | undefined;
    mocks.lookupApiKey.mockResolvedValue('sk-test');
    mocks.setCliApiMode
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectFirstModeSwitch = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const runtimeHost = host();
    const unbind = installTuiApprovals(runtimeHost, context());
    try {
      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'first retry',
        }),
      );
      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledTimes(1);
      });

      runtimeHost.emit(
        'showRetryRequest',
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'second retry',
        }),
      );
      await vi.waitFor(() => {
        expect(mocks.triggerRetry).toHaveBeenCalledWith(
          'same-stream',
          undefined,
        );
      });

      rejectFirstModeSwitch?.(new Error('stale mode switch failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.cancelRetry).not.toHaveBeenCalled();
    } finally {
      unbind();
    }
  });
});

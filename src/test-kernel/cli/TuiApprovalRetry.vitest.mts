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

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import {
  clearApprovals,
  currentApproval,
} from '@cli/chat/tui/state/approvalQueue';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
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

function tui(): {
  readonly runtimeHost: CliRuntimeHost;
  readonly interactions: HostInteractions;
  readonly dispose: () => void;
} {
  const runtimeHost = host();
  const interactions = createTuiHostInteractions(runtimeHost, context());
  return {
    runtimeHost,
    interactions,
    dispose: () => interactions.dispose?.(),
  };
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
  it('does not mutate the runtime host emitter', () => {
    const runtimeHost = host();
    const originalEmit = runtimeHost.emit;
    const interactions = createTuiHostInteractions(runtimeHost, context());
    try {
      expect(runtimeHost.emit).toBe(originalEmit);
    } finally {
      interactions.dispose?.();
    }
  });

  it('auto-switches provider-less relay retries when any personal key exists', async () => {
    const fallbackProvider =
      API_PROVIDERS.find((provider) => provider !== 'openai') ??
      API_PROVIDERS[0];
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === fallbackProvider ? 'sk-test' : undefined,
    );

    const { interactions, dispose } = tui();
    try {
      const result = interactions.requestRetry?.(
        relayRetry({ streamId: 's1' }),
      );

      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
      });
      await expect(result).resolves.toEqual({
        action: 'retry',
        feedback: undefined,
      });
      expect(currentApproval.get()).toBeUndefined();
      expect(mocks.lookupApiKey.mock.calls.map((call) => call[1])).toContain(
        fallbackProvider,
      );
    } finally {
      dispose();
    }
  });

  it('falls back to the retry modal when API key lookup fails', async () => {
    mocks.lookupApiKey.mockRejectedValue(new Error('keychain unavailable'));

    const { interactions, dispose } = tui();
    try {
      const retry = relayRetry({ streamId: 's2', provider: 'openai' });
      void interactions.requestRetry?.(retry);

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 's2' },
        });
      });
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('does not auto-switch when a retry provider is not an API provider', async () => {
    mocks.lookupApiKey.mockResolvedValue('sk-test');

    const { interactions, dispose } = tui();
    try {
      const retry = relayRetry({
        streamId: 'unknown-provider',
        provider: 'custom-provider',
      });
      void interactions.requestRetry?.(retry);

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 'unknown-provider' },
        });
      });
      expect(mocks.lookupApiKey).not.toHaveBeenCalled();
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('auto-switches relay retries detected by monthly-limit message fallback', async () => {
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === 'openai' ? 'sk-openai' : undefined,
    );

    const { interactions, dispose } = tui();
    try {
      const result = interactions.requestRetry?.({
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
      });
      await expect(result).resolves.toEqual({
        action: 'retry',
        feedback: undefined,
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it('auto-switches ChatGPT subscription retries to an OpenAI API key', async () => {
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === 'openai' ? 'sk-openai' : undefined,
    );

    const { interactions, dispose } = tui();
    try {
      const result = interactions.requestRetry?.(
        chatGptSubscriptionRetry('s3'),
      );

      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
        expect(mocks.setCliCodexSubscription).toHaveBeenCalledWith(false);
      });
      await expect(result).resolves.toEqual({
        action: 'retry',
        feedback: undefined,
      });
      expect(currentApproval.get()).toBeUndefined();
      expect(mocks.lookupApiKey.mock.calls.map((call) => call[1])).toEqual([
        'openai',
      ]);
    } finally {
      dispose();
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

    const { interactions, dispose } = tui();
    try {
      const result = interactions.requestRetry?.(
        relayRetry({ streamId: 'interrupted', provider: 'openai' }),
      );
      clearApprovals();
      await expect(result).resolves.toEqual({ action: 'cancel' });

      resolveLookup?.('sk-after-interrupt');
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.setCliApiMode).not.toHaveBeenCalled();
      expect(mocks.triggerRetry).not.toHaveBeenCalled();
      expect(mocks.cancelRetry).not.toHaveBeenCalled();
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      dispose();
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

    const { interactions, dispose } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'unbound', provider: 'openai' }),
    );
    dispose();
    await expect(result).resolves.toEqual({ action: 'cancel' });

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

    const { interactions, dispose } = tui();
    try {
      const result = interactions.requestRetry?.(
        relayRetry({ streamId: 'modal-interrupt', provider: 'openai' }),
      );

      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toMatchObject({
          kind: 'retry',
          payload: { streamId: 'modal-interrupt' },
        });
      });

      clearApprovals();
      await expect(result).resolves.toEqual({ action: 'cancel' });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      dispose();
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

    const { interactions, dispose } = tui();
    try {
      void interactions.requestRetry?.(
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'first retry',
        }),
      );
      void interactions.requestRetry?.(
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
      dispose();
    }
  });

  it('clears an older retry modal when a newer retry auto-switches', async () => {
    mocks.lookupApiKey
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('sk-new');

    const { interactions, dispose } = tui();
    try {
      void interactions.requestRetry?.(
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

      const second = interactions.requestRetry?.(
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'second retry',
        }),
      );

      await vi.waitFor(() => {
        expect(currentApproval.get()).toBeUndefined();
      });
      await expect(second).resolves.toEqual({
        action: 'retry',
        feedback: undefined,
      });
    } finally {
      dispose();
    }
  });

  it('replaces an older retry modal when a newer retry also needs input', async () => {
    mocks.lookupApiKey.mockResolvedValue(undefined);

    const { interactions, dispose } = tui();
    try {
      void interactions.requestRetry?.(
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

      void interactions.requestRetry?.(
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
      dispose();
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

    const { interactions, dispose } = tui();
    try {
      void interactions.requestRetry?.(
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'first retry',
        }),
      );
      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledTimes(1);
      });

      const second = interactions.requestRetry?.(
        relayRetry({
          streamId: 'same-stream',
          provider: 'openai',
          message: 'second retry',
        }),
      );
      await vi.waitFor(() => {
        expect(mocks.setCliApiMode).toHaveBeenCalledTimes(2);
      });
      await expect(second).resolves.toEqual({
        action: 'retry',
        feedback: undefined,
      });

      rejectFirstModeSwitch?.(new Error('stale mode switch failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.cancelRetry).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

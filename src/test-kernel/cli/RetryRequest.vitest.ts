import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalModal } from '@cli/chat/tui/modals/ApprovalModal';
import { RetryRequest } from '@cli/chat/tui/modals/RetryRequest';
import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
} from '@cli/chat/tui/state/approvalQueue';
import type { StreamTabId } from '@shared/schemas';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  loadInk,
  renderInteractive,
  renderOutputAtTerminalSize,
} from '@test/support/inkTestHarness.ts';

describe('CLI retry request', () => {
  afterEach(() => clearApprovals());

  function subscriptionLimitPayload(personalApiKeyAvailable: boolean) {
    return {
      requestId: 'subscription-limit',
      streamId: 'retry-stream' as StreamTabId,
      operation: 'Tool-use call',
      errorMessage: 'ChatGPT subscription usage limit reached.',
      errorDetails: {
        message: 'ChatGPT subscription usage limit reached.',
        exhaustionReason: 'chatgpt-subscription' as const,
        provider: 'openai',
      },
      personalApiKeyAvailable,
    };
  }

  it('dismisses immediately instead of asking for rejection feedback', async () => {
    const { ink, React } = await loadInk();
    const decision = enqueueApproval({
      kind: 'retry',
      payload: {
        requestId: 'retry-request',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Model invocation',
        errorMessage: 'Connection error',
      },
    });
    const { instance, stdin } = renderInteractive(
      ink,
      React.createElement(ApprovalModal, { pending: currentApproval.get() }),
      { columns: 100 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('n');
      await expect(decision).resolves.toMatchObject({ accepted: false });
    } finally {
      instance.unmount();
    }
  });

  it('scrolls a tall error instead of pushing the actions off a short terminal', async () => {
    const { ink, React } = await loadInk();
    const output = await renderOutputAtTerminalSize(
      ink,
      React.createElement(RetryRequest, {
        availableRows: 12,
        payload: {
          requestId: 'tall-error',
          streamId: 'retry-stream' as StreamTabId,
          operation: 'Model invocation',
          errorMessage: Array.from(
            { length: 40 },
            (_, index) => `stack frame ${index + 1}`,
          ).join('\n'),
        },
        onDecide: vi.fn(),
      }),
      100,
      { until: (frame) => frame.includes('y retry') },
    );

    expect(output).toContain('y retry');
    expect(output).toContain('n dismiss');
    expect(output).toContain('more rows');
    expect(output.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('settles the approval queue from a real terminal k input', async () => {
    const { ink, React } = await loadInk();
    const decision = enqueueApproval({
      kind: 'retry',
      payload: subscriptionLimitPayload(true),
    });
    const { instance, stdin } = renderInteractive(
      ink,
      React.createElement(ApprovalModal, {
        pending: currentApproval.get(),
      }),
      { columns: 100 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('k');
      await expect(decision).resolves.toEqual({
        accepted: true,
        apiMode: 'personal',
        disableChatGptSubscription: true,
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      instance.unmount();
    }
  });

  it.each([
    ['subscription', subscriptionLimitPayload(false), 'OpenAI'],
    [
      'relay',
      {
        requestId: 'relay-limit',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Tool-use call',
        errorMessage: 'Relay monthly limit reached.',
        errorDetails: {
          message: 'Relay monthly limit reached.',
          exhaustionReason: 'relay-limit' as const,
          isRelayError: true,
          provider: 'anthropic',
        },
        personalApiKeyAvailable: false,
        missingPersonalApiKeyMessage:
          'No Anthropic API key is configured. Press n to dismiss, then use `/key` to add one.',
      },
      'Anthropic',
    ],
  ] as const)(
    'hides the impossible %s switch and names the missing key',
    async (_route, payload, provider) => {
      const { ink, React } = await loadInk();
      const output = await renderOutputAtTerminalSize(
        ink,
        React.createElement(RetryRequest, {
          payload,
          onDecide: vi.fn(),
        }),
        100,
        { until: (frame) => frame.includes('API key is configured.') },
      );

      expect(output).toContain(`No ${provider} API key is configured.`);
      expect(output).toContain('Press n to dismiss');
      expect(output).toContain('/key');
      expect(output).not.toContain('k use API key and retry');
    },
  );

  it('derives the fallback copy from the failed provider', async () => {
    const { ink, React } = await loadInk();
    const output = await renderOutputAtTerminalSize(
      ink,
      React.createElement(RetryRequest, {
        payload: {
          requestId: 'anthropic-fallback',
          streamId: 'retry-stream' as StreamTabId,
          operation: 'Tool-use call',
          errorDetails: {
            message: 'Relay monthly limit reached.',
            exhaustionReason: 'relay-limit',
            isRelayError: true,
            provider: 'anthropic',
          },
          personalApiKeyAvailable: false,
        },
        onDecide: vi.fn(),
      }),
      100,
      { until: (frame) => frame.includes('API key is configured.') },
    );

    expect(output).toContain('No Anthropic API key is configured.');
    expect(output).not.toContain('OpenAI API key');
  });
});

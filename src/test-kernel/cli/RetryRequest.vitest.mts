import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalModal } from '@cli/chat/tui/modals/ApprovalModal';
import { ConfirmCard } from '@cli/chat/tui/modals/ConfirmCard';
import { RetryRequest } from '@cli/chat/tui/modals/RetryRequest';
import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
} from '@cli/chat/tui/state/approvalQueue';
import type { StreamTabId } from '@shared/schemas';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  FakeStdin,
  FakeStdout,
  loadInk,
} from '@test/support/inkTestHarness.mts';

describe('CLI retry request', () => {
  afterEach(() => clearApprovals());

  it('uses immediate rejection with a plain give-up action', () => {
    const card = RetryRequest({
      payload: {
        requestId: 'retry-request',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Model invocation',
        errorMessage: 'Connection error',
      },
      onDecide: vi.fn(),
    });

    expect(card.type).toBe(ConfirmCard);
    expect(card.props).toMatchObject({
      approveLabel: 'retry',
      rejectLabel: 'give up',
      rejectionMode: 'immediate',
    });
  });

  it('settles the approval queue from a real terminal k input', async () => {
    const { ink, React } = await loadInk();
    const decision = enqueueApproval({
      kind: 'retry',
      payload: {
        requestId: 'subscription-limit',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Tool-use call',
        errorMessage: 'ChatGPT subscription usage limit reached.',
        errorDetails: {
          message: 'ChatGPT subscription usage limit reached.',
          exhaustionReason: 'chatgpt-subscription',
          provider: 'openai',
        },
        personalApiKeyAvailable: true,
      },
    });
    const stdin = new FakeStdin();
    const instance = ink.render(
      React.createElement(ApprovalModal, {
        pending: currentApproval.get(),
      }),
      {
        stdin,
        stdout: new FakeStdout(100),
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
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
    [
      'subscription',
      {
        requestId: 'subscription-limit',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Tool-use call',
        errorMessage: 'ChatGPT subscription usage limit reached.',
        errorDetails: {
          message: 'ChatGPT subscription usage limit reached.',
          exhaustionReason: 'chatgpt-subscription' as const,
          provider: 'openai',
        },
        personalApiKeyAvailable: false,
      },
      'OpenAI',
    ],
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
          'No Anthropic API key is configured. Press n to give up, then use `/key` to add one.',
      },
      'Anthropic',
    ],
  ] as const)(
    'hides the impossible %s switch and names the missing key',
    async (_route, payload, provider) => {
      const { ink, React } = await loadInk();
      const output = ink.renderToString(
        React.createElement(RetryRequest, {
          payload,
          onDecide: vi.fn(),
        }),
        { columns: 100 },
      );

      expect(output).toContain(`No ${provider} API key is configured.`);
      expect(output).toContain('Press n to give up');
      expect(output).toContain('/key');
      expect(output).not.toContain('k use API key and retry');
    },
  );
});

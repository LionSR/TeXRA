import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalModal } from '@cli/chat/tui/modals/ApprovalModal';
import { RetryRequest } from '@cli/chat/tui/modals/RetryRequest';
import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
  type RetryApprovalPayload,
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

  function subscriptionLimitPayload(
    personalApiKeyAvailable: boolean,
  ): RetryApprovalPayload {
    return {
      kind: 'retry',
      data: {
        requestId: 'subscription-limit',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Tool-use call',
        errorMessage: 'ChatGPT subscription usage limit reached.',
        errorDetails: {
          message: 'ChatGPT subscription usage limit reached.',
          exhaustionReason: 'chatgpt-subscription' as const,
          provider: 'openai',
        },
      },
      tui: { personalApiKeyAvailable },
    };
  }

  it('dismisses immediately instead of asking for rejection feedback', async () => {
    const { ink, React } = await loadInk();
    const decision = enqueueApproval({
      kind: 'retry',
      data: {
        requestId: 'retry-request',
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Model invocation',
        errorMessage: 'Connection error',
      },
      tui: {},
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
          kind: 'retry',
          data: {
            requestId: 'tall-error',
            streamId: 'retry-stream' as StreamTabId,
            operation: 'Model invocation',
            errorMessage: Array.from(
              { length: 40 },
              (_, index) => `stack frame ${index + 1}`,
            ).join('\n'),
          },
          tui: {},
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
    const decision = enqueueApproval(subscriptionLimitPayload(true));
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
        disableQuotaRoute: 'chatgpt',
      });
      expect(currentApproval.get()).toBeUndefined();
    } finally {
      instance.unmount();
    }
  });

  it('hides the impossible subscription switch and names the missing key', async () => {
    const { ink, React } = await loadInk();
    const output = await renderOutputAtTerminalSize(
      ink,
      React.createElement(RetryRequest, {
        payload: subscriptionLimitPayload(false),
        onDecide: vi.fn(),
      }),
      100,
      { until: (frame) => frame.includes('API key is configured.') },
    );

    expect(output).toContain('No OpenAI API key is configured.');
    expect(output).toContain('Press n to dismiss');
    expect(output).toContain('/key');
    expect(output).not.toContain('k use API key and retry');
  });
});

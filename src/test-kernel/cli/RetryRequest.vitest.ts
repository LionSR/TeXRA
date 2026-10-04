// Test composition imports

import { describe, expect, it, vi } from 'vitest';

import { ApprovalModal } from '@cli/chat/tui/modals/ApprovalModal';
import { RetryRequest } from '@cli/chat/tui/modals/RetryRequest';
import type {
  ApprovalPayload,
  RetryApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import type { RunId } from '@shared/schemas';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  loadInk,
  renderInteractive,
  renderOutputAtTerminalSize,
} from '@test/support/inkTestHarness.ts';

/** A foreground modal entry whose decision the test awaits. */
function pendingFor(payload: ApprovalPayload): {
  readonly props: {
    readonly payload: ApprovalPayload;
    readonly onDecide: (decision: SurfaceDecision) => void;
  };
  readonly decision: Promise<SurfaceDecision>;
} {
  let onDecide!: (decision: SurfaceDecision) => void;
  const decision = new Promise<SurfaceDecision>((resolve) => {
    onDecide = resolve;
  });
  return { props: { payload, onDecide }, decision };
}

describe('CLI retry request', () => {
  function subscriptionLimitPayload(): RetryApprovalPayload {
    return {
      kind: 'retry',
      data: {
        requestId: 'subscription-limit',
        runId: 'retry-stream' as RunId,
        operation: 'Tool-use call',
        errorMessage: 'ChatGPT subscription usage limit reached.',
        errorDetails: {
          message: 'ChatGPT subscription usage limit reached.',
          classification: { kind: 'chatgpt-subscription' },
          provider: 'openai',
        },
        credentialSwitch: {
          kind: 'decline-route',
          route: 'chatgpt-subscription',
          provider: 'openai',
          automatic: false,
        },
      },
    };
  }

  it('dismisses immediately instead of asking for rejection feedback', async () => {
    const { ink, React } = await loadInk();
    const { props, decision } = pendingFor({
      kind: 'retry',
      data: {
        requestId: 'retry-request',
        runId: 'retry-stream' as RunId,
        operation: 'Model invocation',
        errorMessage: 'Connection error',
      },
    });
    const { instance, stdin } = renderInteractive(
      ink,
      React.createElement(ApprovalModal, props),
      { columns: 100 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('n');
      await expect(decision).resolves.toEqual({ action: 'reject' });
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
            runId: 'retry-stream' as RunId,
            operation: 'Model invocation',
            errorMessage: Array.from(
              { length: 40 },
              (_, index) => `stack frame ${index + 1}`,
            ).join('\n'),
          },
        },
        onDecide: vi.fn(),
      }),
      100,
      { until: (frame) => frame.includes('y retry') },
    );

    expect(output).toContain('y retry');
    expect(output).toContain('n stop run');
    expect(output).toContain('more rows');
    expect(output.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('settles the approval queue from a real terminal k input', async () => {
    const { ink, React } = await loadInk();
    const { props, decision } = pendingFor(subscriptionLimitPayload());
    const { instance, stdin } = renderInteractive(
      ink,
      React.createElement(ApprovalModal, props),
      { columns: 100 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('k');
      await expect(decision).resolves.toEqual({
        action: 'retry',
        credentials: 'personal',
      });
    } finally {
      instance.unmount();
    }
  });
});

// Test composition imports

import { describe, expect, it } from 'vitest';

import { ApprovalModal } from '@cli/chat/tui/modals/ApprovalModal';
import type {
  ApprovalPayload,
  RetryApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import type { RunId } from '@shared/schemas';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { loadInk, renderInteractive } from '@test/support/inkTestHarness.ts';
import type { SurfaceDecision } from '@texra/shared/session/surfaceDecision';

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

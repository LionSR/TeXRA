// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { RetryRequestPanel } from '@progressView/frontend/components/RetryRequestPanel';

// Local imports - shared constants
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/RetryRequestPanel'),
);

function createRetryPermission(): RetryRequestPanel['permission'] {
  return {
    kind: PERMISSION_KIND.RETRY,
    data: {
      streamId: 'stream-1',
      operation: 'model request',
      model: 'test-model',
      errorMessage: 'Relay quota exhausted',
      errorDetails: {
        exhaustionReason: 'relay-limit',
        isRelayError: true,
        userRetryable: true,
      },
    },
  };
}

async function mountPanel(): Promise<RetryRequestPanel> {
  const element = document.createElement(
    'retry-request-panel',
  ) as RetryRequestPanel;
  element.permission = createRetryPermission();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('retry-request-panel', () => {
  it('marks retry action buttons with action ids for shared sizing styles', async () => {
    const element = await mountPanel();

    const buttons = [
      ...(element.shadowRoot?.querySelectorAll(
        '.retry-request__actions wa-button',
      ) ?? []),
    ];

    expect(buttons.map((button) => button.getAttribute('data-action'))).toEqual(
      ['useOwnApiKey', 'retry', 'cancel'],
    );
  });
});

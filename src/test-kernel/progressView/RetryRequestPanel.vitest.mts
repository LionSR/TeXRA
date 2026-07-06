// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { RetryRequestPanel } from '@progressView/frontend/components/RetryRequestPanel';

// Local imports - shared schemas
import type { ProviderErrorPartial } from '@shared/schemas';

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

  it('shows exactly the claimed number of tail characters for truncated partial output', async () => {
    const element = await mountPanel();
    // `formatRetryDetails` is private; TS-private is not runtime-enforced, and
    // this pure-string-formatting logic doesn't need a full render to verify.
    const formatRetryDetails: (details: ProviderErrorPartial) => string | null =
      (element as unknown as Record<string, unknown>)[
        'formatRetryDetails'
      ] as never;

    const text = formatRetryDetails.call(element, {
      isRelayError: false,
      userRetryable: true,
      partialText: 'x'.repeat(2000),
    });

    expect(text).toContain('--- Partial Output (last 1024 of 2000 chars) ---');
    const tail = (text ?? '').split('\n').at(-1) ?? '';
    // "…" plus exactly 1024 content characters, not 1023.
    expect(tail.replace(/^…/, '')).toHaveLength(1024);
  });

  it('reports and truncates by grapheme count, not UTF-16 code-unit length', async () => {
    const element = await mountPanel();
    const formatRetryDetails: (details: ProviderErrorPartial) => string | null =
      (element as unknown as Record<string, unknown>)[
        'formatRetryDetails'
      ] as never;

    // Each 😀 is a surrogate pair (2 UTF-16 units, 1 grapheme). 600 of them
    // is 1200 code units but only 600 graphemes — under the 1024 threshold,
    // so this must NOT be reported or truncated as if it were over it.
    const text = formatRetryDetails.call(element, {
      isRelayError: false,
      userRetryable: true,
      partialText: '😀'.repeat(600),
    });

    expect(text).toContain('--- Partial Output (600 chars) ---');
    expect(text).not.toContain('last 1024');
  });
});

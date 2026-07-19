// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types

// Local imports - shared schemas
import type { RetryRequestPanel } from '@progressView/frontend/components/RetryRequestPanel';
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
      requestId: 'relay-retry',
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

// `formatRetryDetails` is private; TS-private is not runtime-enforced, and
// this pure-string-formatting logic doesn't need a full render to verify.
function formatRetryDetails(
  element: RetryRequestPanel,
  details: ProviderErrorPartial,
): string | null {
  const format: (details: ProviderErrorPartial) => string | null = (
    element as unknown as Record<string, unknown>
  )['formatRetryDetails'] as never;
  return format.call(element, details);
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

  it('distinguishes a fresh direct-model run from retrying Copilot', async () => {
    const element = await mountPanel();
    element.permission = {
      kind: PERMISSION_KIND.RETRY,
      data: {
        requestId: 'copilot-retry',
        streamId: 'stream-1',
        operation: 'model request',
        model: 'copilot:sonnet46',
        errorMessage: 'Copilot quota exhausted',
        errorDetails: {
          exhaustionReason: 'copilot-subscription',
          isRelayError: false,
          userRetryable: true,
        },
      },
    };
    await element.updateComplete;

    const actions = element.shadowRoot?.querySelector(
      '.retry-request__actions',
    );
    expect(actions?.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      'Start with own API key',
    );
    expect(actions?.textContent).toContain('Retry Copilot');
  });

  it('shows exactly the claimed number of tail characters for truncated partial output', async () => {
    const element = await mountPanel();

    const text = formatRetryDetails(element, {
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

    // Each 😀 is a surrogate pair (2 UTF-16 units, 1 grapheme). 600 of them
    // is 1200 code units but only 600 graphemes — under the 1024 threshold,
    // so this must NOT be reported or truncated as if it were over it.
    const text = formatRetryDetails(element, {
      isRelayError: false,
      userRetryable: true,
      partialText: '😀'.repeat(600),
    });

    expect(text).toContain('--- Partial Output (600 chars) ---');
    expect(text).not.toContain('last 1024');
  });

  it('agrees on truncation at the exact boundary (maxTailChars + 1 total chars)', async () => {
    const element = await mountPanel();

    // At exactly 1025 chars, tailWithEllipsis(text, 1025) returns the text
    // unchanged (1025 <= its own budget of 1025) — the header must not
    // claim truncation when nothing was actually cut.
    const text = formatRetryDetails(element, {
      isRelayError: false,
      userRetryable: true,
      partialText: 'x'.repeat(1025),
    });

    expect(text).toContain('--- Partial Output (1025 chars) ---');
    expect(text).not.toContain('last 1024');
    expect((text ?? '').split('\n').at(-1)).toBe('x'.repeat(1025));
  });

  it('truncates one char past the boundary (maxTailChars + 2 total chars)', async () => {
    const element = await mountPanel();

    const text = formatRetryDetails(element, {
      isRelayError: false,
      userRetryable: true,
      partialText: 'x'.repeat(1026),
    });

    expect(text).toContain('--- Partial Output (last 1024 of 1026 chars) ---');
    const tail = (text ?? '').split('\n').at(-1) ?? '';
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.replace(/^…/, '')).toHaveLength(1024);
  });
});
